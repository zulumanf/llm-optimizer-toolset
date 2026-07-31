import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listPackets } from "@/db/knowledge";
import { listPacketTemplates } from "@/lib/knowledge/context/templates";
import { Badge } from "@/components/ui/badge";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";

export const dynamic = "force-dynamic";

export default async function PacketsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const packets = await listPackets(id);
  const templates = listPacketTemplates();

  return (
    <div className="mx-auto max-w-6xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
        {" / "}Packets
      </nav>
      <h1 className="mb-1 text-2xl font-semibold">Context packets</h1>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        What an agent was actually shown, stored so a past decision stays
        reproducible. Every packet is built to a named template, inside a token
        budget, with instructions carried separately from facts and every
        omission recorded.
      </p>

      <KnowledgeLayerNav projectId={id} />

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Templates</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {templates.map((template) => (
            <div key={template.key} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{template.name}</span>
                <Badge variant="outline">{template.audience}</Badge>
                {template.requiresClaims && <Badge variant="secondary">needs claims</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {template.defaultTokenBudget.toLocaleString()} token budget · min freshness{" "}
                {template.minFreshness.replace(/_/g, " ")} · privacy{" "}
                {template.allowedPrivacy.join(", ")}
              </p>
              {template.excludedCategories.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Never includes: {template.excludedCategories.join(", ")}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <h2 className="mb-2 text-lg font-medium">Built packets</h2>
      {packets.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No packets built yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A workflow node that names a template builds one when it runs.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {packets.map((packet) => (
            <Link
              key={packet.id}
              href={`/projects/${id}/knowledge/packets/${packet.id}`}
              className="block rounded-lg border p-3 transition-colors hover:bg-secondary/40"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {packet.templateKey ?? "legacy evidence packet"}
                </span>
                {packet.agentKey && <Badge variant="outline">{packet.agentKey}</Badge>}
                <Badge variant="secondary">{packet.audience}</Badge>
                {packet.missingCount > 0 && (
                  <Badge variant="outline">{packet.missingCount} known gaps</Badge>
                )}
              </div>
              {packet.objective && (
                <p className="mt-1 text-sm text-muted-foreground">{packet.objective}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {packet.tokenCount.toLocaleString()} tokens
                {packet.tokenBudget ? ` of ${packet.tokenBudget.toLocaleString()}` : ""} ·{" "}
                {packet.claimCount} claims · {packet.withheldCount} withheld ·{" "}
                {packet.builtAt.slice(0, 16).replace("T", " ")} ·{" "}
                <span className="font-mono">{packet.contentHash.slice(0, 12)}…</span>
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
