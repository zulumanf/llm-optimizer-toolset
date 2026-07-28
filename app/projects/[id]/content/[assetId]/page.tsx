import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/db/client";
import { getProject } from "@/db/projects";
import { Badge } from "@/components/ui/badge";
import { AssetControls } from "@/components/content/asset-controls";
import type { ContentBrief } from "@/lib/content/prompts";
import type { ContentValidation } from "@/lib/content/validate";
import { formatDate } from "@/lib/format";

interface VerificationBlob {
  gate?: ContentValidation;
  passed?: boolean;
  factVerification?: {
    verdicts: { excerpt: string; verdict: string; reason: string }[];
  };
}

export default async function AssetPage({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}) {
  const { id: projectId, assetId } = await params;
  const project = await getProject(projectId);
  const [asset] = await sql`
    select * from content_assets where id = ${assetId}
  `;
  if (!project || !asset || asset.projectId !== projectId) notFound();

  const [latest] = await sql`
    select version, body, author, verification, created_at
    from content_versions where asset_id = ${assetId}
    order by version desc limit 1
  `;
  const versions = await sql`
    select version, author, created_at from content_versions
    where asset_id = ${assetId} order by version desc
  `;
  const frozenSets = await sql`
    select v.id, s.name as set_name, v.version
    from prompt_set_versions v join prompt_sets s on s.id = v.prompt_set_id
    where s.project_id = ${projectId}
    order by s.name asc, v.version desc
  `;

  const brief = asset.brief as ContentBrief;
  const verification = (latest?.verification as VerificationBlob | null) ?? null;
  const gate = verification?.gate ?? null;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${projectId}/content`} className="hover:text-foreground">
          Content
        </Link>
        {" / "}{asset.title as string}
      </nav>

      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{asset.title as string}</h1>
            <Badge>{asset.status as string}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {(asset.assetType as string).replace(/_/g, " ")} → &ldquo;
            {asset.targetPrompt as string}&rdquo;
            {asset.publishedUrl ? ` · published at ${asset.publishedUrl}` : ""}
          </p>
        </div>
        <AssetControls
          assetId={assetId}
          status={asset.status as string}
          versions={frozenSets.map((v) => ({
            id: v.id as string,
            label: `${v.setName} — v${v.version}`,
          }))}
        />
      </div>

      <section className="mb-6 rounded-md border bg-muted/30 p-4 text-sm">
        <p className="mb-1 font-medium">Brief</p>
        <p><span className="text-muted-foreground">Audience:</span> {brief.audience}</p>
        <p><span className="text-muted-foreground">Angle:</span> {brief.angle}</p>
        <p className="text-muted-foreground">
          Outline: {brief.outline.join(" · ")}
        </p>
      </section>

      {gate && (
        <section className="mb-6 rounded-md border p-4 text-sm">
          <p className="mb-1 font-medium">
            Citation gate:{" "}
            {gate.ok ? (
              <span className="text-success">passed</span>
            ) : (
              <span className="text-destructive">failed</span>
            )}
            {verification?.factVerification && (
              <>
                {" "}· fact verifier:{" "}
                {verification.passed ? (
                  <span className="text-success">passed</span>
                ) : (
                  <span className="text-destructive">issues found</span>
                )}
              </>
            )}
          </p>
          {[...gate.uncitedSubjectSentences, ...gate.uncitedNumericSentences,
            ...gate.uncitedSuperlatives].slice(0, 5).map((s, i) => (
            <p key={i} className="text-xs text-destructive">uncited: &ldquo;{s}&rdquo;</p>
          ))}
          {verification?.factVerification?.verdicts
            .filter((v) => v.verdict !== "verified")
            .slice(0, 5)
            .map((v, i) => (
              <p key={`fv-${i}`} className="text-xs text-warning">
                {v.verdict}: &ldquo;{v.excerpt}&rdquo; — {v.reason}
              </p>
            ))}
        </section>
      )}

      {latest ? (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-medium">
            Draft v{latest.version as number}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              by {latest.author as string} · {formatDate(latest.createdAt as Date)} ·
              [claim:…] tokens are stripped in the publish package
            </span>
          </h2>
          <pre className="whitespace-pre-wrap rounded-md border p-4 font-mono text-sm">
            {latest.body as string}
          </pre>
        </section>
      ) : (
        <p className="mb-6 text-sm text-muted-foreground">
          No draft yet — generate one from the brief.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Version history: {versions.map((v) => `v${v.version} (${v.author})`).join(" · ")}
      </p>
    </div>
  );
}
