import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import {
  getPromptSet,
  listActivePrompts,
  listVersionSummaries,
  getVersion,
} from "@/db/prompt-sets";
import { isSameContent } from "@/lib/prompts/freeze";
import type { FrozenPrompt } from "@/lib/prompts/types";
import { Badge } from "@/components/ui/badge";
import { SetFormDialog } from "@/components/prompts/set-form-dialog";
import { PromptFormDialog } from "@/components/prompts/prompt-form-dialog";
import { PromptRowControls } from "@/components/prompts/prompt-row-controls";
import { FreezeButton } from "@/components/prompts/freeze-button";
import { DuplicateSetDialog } from "@/components/prompts/duplicate-set-dialog";
import { ImportPromptsDialog } from "@/components/prompts/import-prompts-dialog";
import { clusterPrompts, PROMPT_CLUSTER_VERSION } from "@/lib/prompts/cluster";
import { formatDate } from "@/lib/format";

export default async function PromptSetDetailPage({
  params,
}: {
  params: Promise<{ id: string; setId: string }>;
}) {
  const { id: projectId, setId } = await params;
  const [project, set] = await Promise.all([
    getProject(projectId),
    getPromptSet(setId),
  ]);
  if (!project || !set || set.projectId !== projectId) notFound();

  const [prompts, versions] = await Promise.all([
    listActivePrompts(setId),
    listVersionSummaries(setId),
  ]);
  const latest = versions[0] ?? null;
  const latestVersion = latest ? await getVersion(setId, latest.version) : null;

  const liveSnapshot: FrozenPrompt[] = prompts.map((p, i) => ({
    promptId: p.id,
    text: p.text,
    category: p.category,
    language: p.language,
    position: i + 1,
  }));
  const editedSinceFreeze =
    latestVersion !== null &&
    !isSameContent(latestVersion.frozenPrompts, liveSnapshot);
  const isEditable = set.archivedAt === null && project.status === "active";
  const orderedIds = prompts.map((p) => p.id);

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
          href={`/projects/${projectId}/prompts`}
          className="hover:text-foreground"
        >
          Prompts
        </Link>
        {" / "}{set.name}
      </nav>

      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{set.name}</h1>
            {set.archivedAt && <Badge variant="outline">archived</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {prompts.length} prompt{prompts.length === 1 ? "" : "s"}
            {latest
              ? ` · last frozen v${latest.version} (${formatDate(latest.frozenAt)})`
              : " · never frozen"}
            {editedSinceFreeze && (
              <span className="text-warning"> · edited since freeze ⚠</span>
            )}
          </p>
          {set.description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {set.description}
            </p>
          )}
        </div>
        {isEditable && (
          <div className="flex shrink-0 gap-2">
            <SetFormDialog mode="edit" set={set} />
            <ImportPromptsDialog setId={set.id} />
            <DuplicateSetDialog sourceSetId={set.id} sourceName={set.name} />
            <FreezeButton
              setId={set.id}
              nextVersion={(latest?.version ?? 0) + 1}
              promptCount={prompts.length}
              disabled={prompts.length === 0 || (latest !== null && !editedSinceFreeze)}
            />
          </div>
        )}
      </div>

      {prompts.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No prompts yet. Write them exactly as a real user would ask
            (docs/07: no brand priming unless the category is branded).
          </p>
          {isEditable && (
            <div className="mt-3">
              <PromptFormDialog mode="add" setId={set.id} existingTexts={prompts.map((p) => p.text)} />
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-lg border">
          <ul className="divide-y">
            {prompts.map((p, i) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm">{p.text}</p>
                </div>
                <Badge variant="secondary">{p.category}</Badge>
                {p.language !== "en" && (
                  <Badge variant="outline">{p.language}</Badge>
                )}
                {isEditable && (
                  <PromptRowControls
                    prompt={p}
                    orderedIds={orderedIds}
                    index={i}
                  />
                )}
              </li>
            ))}
          </ul>
          {isEditable && (
            <div className="border-t p-3">
              <PromptFormDialog mode="add" setId={set.id} existingTexts={prompts.map((p) => p.text)} />
            </div>
          )}
        </div>
      )}

      {prompts.length > 1 && (
        <section className="mt-8">
          <h2 className="mb-1 text-lg font-medium">Clusters</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            Deterministic grouping by category and shared terms ({PROMPT_CLUSTER_VERSION}) —
            computed on read, for talking about coverage, not a stored fact.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {clusterPrompts(prompts).map((cluster) => (
              <div key={cluster.key} className="rounded-lg border p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-sm font-medium">{cluster.label}</span>
                  <Badge variant="secondary">{cluster.category}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {cluster.promptIds.length}
                  </span>
                </div>
                <ul className="space-y-0.5">
                  {cluster.promptIds.map((pid) => {
                    const prompt = prompts.find((p) => p.id === pid);
                    return prompt ? (
                      <li key={pid} className="truncate font-mono text-xs text-muted-foreground">
                        {prompt.text}
                      </li>
                    ) : null;
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-lg font-medium">Versions</h2>
        {versions.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No frozen versions yet. Freezing snapshots the current prompts
            immutably — runs always execute a frozen version (docs/07).
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {versions.map((v) => (
              <li key={v.id}>
                <Link
                  href={`/projects/${projectId}/prompts/${setId}/v/${v.version}`}
                  className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
                >
                  <span className="font-medium">v{v.version}</span>
                  <span className="text-muted-foreground">
                    {v.promptCount} prompts · {formatDate(v.frozenAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
