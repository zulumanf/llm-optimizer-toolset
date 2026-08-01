import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listSources, knowledgeSummary } from "@/db/knowledge";
import { Badge } from "@/components/ui/badge";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";
import { UploadSource } from "@/components/knowledge/upload-source";
import { ExtractClaimsButton } from "@/components/knowledge/extract-claims-button";

export const dynamic = "force-dynamic";

const EXTRACTION_TONE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  extracted: "default",
  pending: "secondary",
  running: "secondary",
  empty: "outline",
  unsupported: "outline",
  failed: "destructive",
};

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default async function SourcesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [sources, summary] = await Promise.all([listSources(id), knowledgeSummary(id)]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
        {" / "}Sources
      </nav>
      <h1 className="mb-1 text-2xl font-semibold">Source library</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Every raw artifact this client has supplied, stored content-addressed and
        never overwritten. A changed source becomes a new version; the
        predecessor stays readable so the claims it supports remain explicable.
      </p>

      <KnowledgeLayerNav projectId={id} />

      <UploadSource projectId={id} />

      {summary.unreadableSources > 0 && (
        <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <strong>{summary.unreadableSources}</strong> source
          {summary.unreadableSources === 1 ? " is" : "s are"} held but not readable —
          an unsupported format or a failed parse. The originals are stored and
          hashed; no text was extracted, and no OCR is performed.
        </p>
      )}

      {sources.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No sources yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Ingest a document, website, export or transcript and it will appear
            here with its hash, extraction status and the claims it supports.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sources.map((source) => (
            <div
              key={source.id}
              className={
                source.supersededAt
                  ? "rounded-lg border border-dashed p-3 opacity-70"
                  : "rounded-lg border p-3"
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{source.label}</span>
                <Badge variant="outline">{source.sourceType.replace(/_/g, " ")}</Badge>
                <Badge variant={EXTRACTION_TONE[source.extractionStatus] ?? "outline"}>
                  {source.extractionStatus}
                </Badge>
                {source.privacy !== "public" && (
                  <Badge variant="secondary">{source.privacy.replace(/_/g, " ")}</Badge>
                )}
                {source.retention === "legal_hold" && <Badge>legal hold</Badge>}
                {source.version > 1 && <Badge variant="outline">v{source.version}</Badge>}
                {source.supersededAt && (
                  <span className="text-xs text-muted-foreground">superseded</span>
                )}
              </div>

              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                <div>
                  <dt className="inline font-medium">Received: </dt>
                  <dd className="inline">{source.retrievedAt.slice(0, 10)}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Effective: </dt>
                  <dd className="inline">{source.effectiveDate ?? "not stated"}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Size: </dt>
                  <dd className="inline">
                    {bytes(source.byteSize)} · {source.mimeType}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">Claims: </dt>
                  <dd className="inline">{source.claimCount}</dd>
                </div>
                <div className="col-span-2 sm:col-span-4">
                  <dt className="inline font-medium">Parser: </dt>
                  <dd className="inline">
                    {source.extractorKey
                      ? `${source.extractorKey} (${source.extractorVersion}) — ${source.textLength.toLocaleString()} characters`
                      : "not run"}
                  </dd>
                </div>
                <div className="col-span-2 sm:col-span-4">
                  <dt className="inline font-medium">SHA-256: </dt>
                  <dd className="inline font-mono">{source.sha256.slice(0, 32)}…</dd>
                </div>
              </dl>

              {source.extractionStatus === "unsupported" && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Stored and hashed for audit. No text extractor exists for this
                  format, and no OCR is performed — this is not a failure, it is
                  a stated limit.
                </p>
              )}
              {!source.supersededAt &&
                ["extracted", "normalized"].includes(source.extractionStatus) && (
                  <div className="mt-2">
                    <ExtractClaimsButton
                      sourceArtifactId={source.id}
                      projectId={id}
                    />
                  </div>
                )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
