import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { listWikiPages, pageVersionHistory } from "@/db/knowledge";
import { readActivePage, readPageProvenance } from "@/lib/knowledge/compiler/compile";
import { getDependencies } from "@/lib/knowledge/build/planner";
import { Badge } from "@/components/ui/badge";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";

export const dynamic = "force-dynamic";

export default async function WikiPageDetail({
  params,
}: {
  params: Promise<{ id: string; slug: string }>;
}) {
  const { id, slug } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const page = await readActivePage({ projectId: id, slug });
  if (!page) {
    const known = await listWikiPages(id);
    return (
      <div className="mx-auto max-w-4xl p-6">
        <KnowledgeLayerNav projectId={id} />
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            &ldquo;{slug}&rdquo; has not been compiled for this client
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {known.length === 0
              ? "Nothing has been compiled yet."
              : "It may be stale and awaiting its first successful build."}
          </p>
        </div>
      </div>
    );
  }

  const [provenance, dependencies, history] = await Promise.all([
    readPageProvenance(page.versionId),
    getDependencies(page.pageId),
    pageVersionHistory(page.pageId),
  ]);

  // Resolve the ids the provenance rows reference, so a section shows the
  // claim's wording rather than a uuid an operator has to go look up.
  const claimIds = [...new Set(provenance.flatMap((p) => p.claimIds))];
  const claimRows =
    claimIds.length > 0
      ? await sql`
          select id, canonical_text, category, status,
            to_char(as_of, 'YYYY-MM-DD') as as_of
          from claims where id = any(${claimIds})
        `
      : [];
  const claimById = new Map(
    claimRows.map((row) => [
      row.id as string,
      {
        text: row.canonicalText as string,
        category: row.category as string,
        status: row.status as string,
        asOf: (row.asOf as string | null) ?? null,
      },
    ])
  );

  const instructionIds = [...new Set(provenance.flatMap((p) => p.instructionVersionIds))];
  const instructionRows =
    instructionIds.length > 0
      ? await sql`
          select v.id, i.title, i.instruction_type
          from knowledge_instruction_versions v
          join knowledge_instructions i on i.id = v.instruction_id
          where v.id = any(${instructionIds})
        `
      : [];
  const instructionById = new Map(
    instructionRows.map((row) => [
      row.id as string,
      { title: row.title as string, type: row.instructionType as string },
    ])
  );

  const byType = new Map<string, number>();
  for (const dep of dependencies) {
    byType.set(dep.type, (byType.get(dep.type) ?? 0) + 1);
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
        {" / "}
        <Link href={`/projects/${id}/knowledge/wiki`} className="hover:text-foreground">
          Wiki
        </Link>
        {" / "}{slug}
      </nav>

      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold">{page.title}</h1>
        <Badge variant={page.freshness === "current" ? "default" : "secondary"}>
          {page.freshness.replace(/_/g, " ")}
        </Badge>
        {page.stale && <Badge variant="secondary">stale</Badge>}
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        v{page.version} · {page.tokenCount.toLocaleString()} tokens · compiled{" "}
        {page.generatedAt.slice(0, 10)} by {page.compilerVersion} · privacy{" "}
        {page.privacy.replace(/_/g, " ")}
      </p>

      <KnowledgeLayerNav projectId={id} />

      <p className="mb-4 rounded-md border bg-secondary/30 p-3 text-sm text-muted-foreground">
        This page is a <strong>rendering</strong> of canonical records, not a
        source of truth. Editing it would change nothing — the only route to a
        different statement here is a new approved claim.
      </p>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Compiled content</h2>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border bg-secondary/20 p-4 text-sm">
          {page.body}
        </pre>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-medium">Section provenance</h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Every material section names the claims, evidence and instructions it
          was built from. A section with no provenance fails the build rather
          than shipping.
        </p>
        <div className="space-y-2">
          {provenance.map((section) => (
            <details key={section.sectionKey} className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm">
                <span className="font-medium">{section.heading}</span>{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {section.sectionKey}
                </span>{" "}
                {section.material ? (
                  <Badge variant="default">material</Badge>
                ) : (
                  <Badge variant="outline">descriptive</Badge>
                )}
              </summary>
              <div className="mt-3 space-y-3 text-sm">
                <div>
                  <h3 className="text-xs font-medium uppercase text-muted-foreground">
                    Claims used ({section.claimIds.length})
                  </h3>
                  {section.claimIds.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None.</p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {section.claimIds.map((claimId) => {
                        const claim = claimById.get(claimId);
                        return (
                          <li key={claimId} className="text-sm">
                            {claim ? claim.text : "(claim no longer readable)"}
                            <span className="ml-1 text-xs text-muted-foreground">
                              {claim?.asOf ? `— as of ${claim.asOf}` : ""}
                              {claim ? ` · ${claim.category} · ${claim.status}` : ""}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
                {section.instructionVersionIds.length > 0 && (
                  <div>
                    <h3 className="text-xs font-medium uppercase text-muted-foreground">
                      Instructions applied
                    </h3>
                    <ul className="mt-1 space-y-1">
                      {section.instructionVersionIds.map((versionId) => {
                        const instruction = instructionById.get(versionId);
                        return (
                          <li key={versionId} className="text-sm">
                            {instruction
                              ? `${instruction.title} (${instruction.type.replace(/_/g, " ")})`
                              : versionId}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
                  <div>
                    <dt className="inline font-medium">Evidence: </dt>
                    <dd className="inline">{section.evidenceIds.length}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Sources: </dt>
                    <dd className="inline">{section.sourceArtifactIds.length}</dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Compiler: </dt>
                    <dd className="inline">{section.compilerVersion}</dd>
                  </div>
                </dl>
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-medium">Dependencies ({dependencies.length})</h2>
        <p className="mb-2 text-sm text-muted-foreground">
          A change to any of these marks this page stale — and marks nothing
          else. This is what keeps a rebuild incremental.
        </p>
        <div className="flex flex-wrap gap-2">
          {[...byType.entries()].map(([type, count]) => (
            <Badge key={type} variant="outline">
              {type.replace(/_/g, " ")} × {count}
            </Badge>
          ))}
          {dependencies.length === 0 && (
            <p className="text-sm text-muted-foreground">
              None declared — this page depends on nothing and will only rebuild
              when forced.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-lg font-medium">Version history</h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Versions are immutable. A rebuild whose output is identical produces no
          new version, so every row here is a real change.
        </p>
        <div className="space-y-1">
          {history.map((version) => (
            <div
              key={version.id}
              className={
                version.id === page.versionId
                  ? "rounded-md border border-foreground/30 p-2 text-sm"
                  : "rounded-md border p-2 text-sm"
              }
            >
              <span className="font-medium">v{version.version}</span>
              {version.id === page.versionId && (
                <Badge className="ml-2" variant="default">active</Badge>
              )}
              <span className="ml-2 text-xs text-muted-foreground">
                {version.generatedAt.slice(0, 16).replace("T", " ")} ·{" "}
                {version.tokenCount.toLocaleString()} tokens · {version.templateVersion} ·{" "}
                <span className="font-mono">{version.contentHash.slice(0, 12)}…</span>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
