import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listBuilds, buildItems } from "@/db/knowledge";
import { Badge } from "@/components/ui/badge";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  completed: "default",
  running: "secondary",
  partial: "secondary",
  failed: "destructive",
};

export default async function BuildsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const builds = await listBuilds(id);
  const items = await Promise.all(
    builds.slice(0, 5).map(async (build) => ({ build, rows: await buildItems(build.id) }))
  );
  const detailById = new Map(items.map((entry) => [entry.build.id, entry.rows]));

  const totalPages = builds.reduce((sum, b) => sum + b.compiled + b.noOp, 0);
  const totalNoOp = builds.reduce((sum, b) => sum + b.noOp, 0);
  const noOpShare = totalPages > 0 ? Math.round((totalNoOp / totalPages) * 100) : null;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
        {" / "}Builds
      </nav>
      <h1 className="mb-1 text-2xl font-semibold">Knowledge builds</h1>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Compilation is incremental: a canonical change marks the pages that
        depend on it and only those are rebuilt. A rebuild whose output is
        unchanged is recorded as a <em>no-op</em> and produces no new version.
      </p>

      <KnowledgeLayerNav projectId={id} />

      {noOpShare !== null && (
        <p className="mb-4 rounded-md border bg-secondary/30 p-3 text-sm text-muted-foreground">
          <strong>{noOpShare}%</strong> of page compilations across these builds
          changed nothing. A high share is not waste — it is the hash check doing
          its job — but a persistently high one means something is marking too
          much stale.
        </p>
      )}

      {builds.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No builds yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Approving a claim marks the dependent pages stale and enqueues a build.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {builds.map((build) => {
            const rows = detailById.get(build.id);
            return (
              <div key={build.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATUS_TONE[build.status] ?? "outline"}>{build.status}</Badge>
                  <span className="text-sm">
                    {build.compiled} compiled · {build.noOp} unchanged ·{" "}
                    {build.failed} failed
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {build.trigger}
                    {build.triggerRef ? ` (${build.triggerRef})` : ""} ·{" "}
                    {build.durationMs}ms · {build.startedAt.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                {build.status === "partial" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Reported as <strong>partial</strong>, not completed — some pages
                    failed and stay stale for the next build. An undisclosed
                    partial result is the failure this platform refuses.
                  </p>
                )}
                {build.error && (
                  <p className="mt-1 text-xs text-destructive">{build.error}</p>
                )}
                {rows && rows.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      {rows.length} page{rows.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {rows.map((row) => (
                        <li key={row.slug} className="text-xs">
                          <span className="font-mono">{row.slug}</span>{" "}
                          <span
                            className={
                              row.status === "failed"
                                ? "text-destructive"
                                : "text-muted-foreground"
                            }
                          >
                            — {row.status}
                            {row.reason ? `: ${row.reason}` : ""}
                            {row.tokenCount > 0 ? ` (${row.tokenCount} tokens)` : ""}
                          </span>
                          {row.error && (
                            <span className="block text-destructive">{row.error}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
