import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listWikiPages } from "@/db/knowledge";
import { Badge } from "@/components/ui/badge";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";

export const dynamic = "force-dynamic";

const FRESHNESS_TONE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  current: "default",
  nearing_review: "secondary",
  superseded: "outline",
  stale: "destructive",
  expired: "destructive",
  unknown: "outline",
};

export default async function WikiIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const pages = await listWikiPages(id);
  const hotFiles = pages.filter((p) => p.pageType === "hot_file");
  const rest = pages.filter((p) => p.pageType !== "hot_file");
  const stale = pages.filter((p) => p.stale);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
        {" / "}Wiki
      </nav>
      <h1 className="mb-1 text-2xl font-semibold">Compiled wiki</h1>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Generated from canonical records — never hand-authored, and never
        authoritative. Editing a page cannot change what the platform believes;
        the only route to a different belief is a new approved claim. Each page
        records the claims, evidence and instructions behind every material
        section.
      </p>

      <KnowledgeLayerNav projectId={id} />

      {stale.length > 0 && (
        <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <strong>{stale.length}</strong> page{stale.length === 1 ? "" : "s"} stale —
          a canonical change has invalidated them and they are waiting on a
          rebuild. Their content is the last successful compilation, not the
          current truth.
        </p>
      )}

      {pages.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">Nothing compiled yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Approve a claim, or run a build, and the pages will appear here.
          </p>
        </div>
      ) : (
        <>
          <Section title="Hot files" pages={hotFiles} projectId={id} />
          <Section title="Pages" pages={rest} projectId={id} />
        </>
      )}
    </div>
  );
}

function Section({
  title,
  pages,
  projectId,
}: {
  title: string;
  pages: Awaited<ReturnType<typeof listWikiPages>>;
  projectId: string;
}) {
  if (pages.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-medium">{title}</h2>
      <div className="space-y-2">
        {pages.map((page) => {
          const overBudget =
            page.tokenBudget !== null && page.tokenCount > page.tokenBudget;
          return (
            <Link
              key={page.id}
              href={`/projects/${projectId}/knowledge/wiki/${page.slug}`}
              className="block rounded-lg border p-3 transition-colors hover:bg-secondary/40"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{page.title}</span>
                <span className="font-mono text-xs text-muted-foreground">{page.slug}</span>
                <Badge variant={FRESHNESS_TONE[page.freshness] ?? "outline"}>
                  {page.freshness.replace(/_/g, " ")}
                </Badge>
                {page.stale && <Badge variant="secondary">stale</Badge>}
                {page.privacy !== "public" && (
                  <Badge variant="outline">{page.privacy.replace(/_/g, " ")}</Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {page.version === null
                  ? "never compiled"
                  : `v${page.version} · ${page.tokenCount.toLocaleString()} tokens`}
                {page.tokenBudget !== null && ` of ${page.tokenBudget.toLocaleString()} budget`}
                {overBudget && " — over budget"}
                {" · "}
                {page.dependencyCount} dependenc{page.dependencyCount === 1 ? "y" : "ies"}
                {page.compilerVersion && ` · ${page.compilerVersion}`}
              </p>
              {page.stale && page.staleReason && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Stale because: <span className="font-mono">{page.staleReason}</span>
                </p>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
