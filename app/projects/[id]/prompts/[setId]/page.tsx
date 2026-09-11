import { PageHeader, PageShell } from "@/components/layout/page";
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
import { GenerateMarketDialog } from "@/components/prompts/generate-market-dialog";
import { SuggestionsPanel } from "@/components/prompts/suggestions-panel";
import { listPromptSuggestions } from "@/lib/prompts/suggest";
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

  const [prompts, versions, suggestions] = await Promise.all([
    listActivePrompts(setId),
    listVersionSummaries(setId),
    listPromptSuggestions(setId),
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
    <PageShell>
      <PageHeader
        crumbs={[
          { label: "Projects", href: "/projects" },
          { label: project.name, href: `/projects/${projectId}` },
          { label: "Prompts", href: `/projects/${projectId}/prompts` },
          { label: set.name },
        ]}
        title={set.name}
        badge={set.archivedAt && <Badge variant="outline">archived</Badge>}
        description={
          <>
            {prompts.length} prompt{prompts.length === 1 ? "" : "s"}
            {latest
              ? ` · last frozen v${latest.version} (${formatDate(latest.frozenAt)})`
              : " · never frozen"}
            {editedSinceFreeze && (
              <span className="text-warning"> · edited since freeze ⚠</span>
            )}
            {set.description && (
              <span className="block mt-1">{set.description}</span>
            )}
          </>
        }
        actions={
          isEditable && (
            <div className="flex shrink-0 gap-2">
              <SetFormDialog mode="edit" set={set} />
              <ImportPromptsDialog setId={set.id} />
              <GenerateMarketDialog setId={set.id} />
              <DuplicateSetDialog sourceSetId={set.id} sourceName={set.name} />
              <FreezeButton
                setId={set.id}
                nextVersion={(latest?.version ?? 0) + 1}
                promptCount={prompts.length}
                disabled={prompts.length === 0 || (latest !== null && !editedSinceFreeze)}
              />
            </div>
          )
        }
      />

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

      {isEditable && (
        <SuggestionsPanel
          setId={set.id}
          suggestions={suggestions.map((s) => ({
            id: s.id,
            text: s.text,
            category: s.category,
            tier: s.tier,
            audience: s.audience,
            priceTier: s.priceTier,
            neighborhood: s.neighborhood,
            building: s.building,
            propertyType: s.propertyType,
            origin: s.origin,
            rationale: s.rationale,
          }))}
        />
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
    </PageShell>
  );
}
