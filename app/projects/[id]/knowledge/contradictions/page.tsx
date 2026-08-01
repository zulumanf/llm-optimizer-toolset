import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listContradictions } from "@/db/knowledge";
import { Badge } from "@/components/ui/badge";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";
import { ResolveContradiction } from "@/components/knowledge/resolve-contradiction";

export const dynamic = "force-dynamic";

const SEVERITY_TONE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  critical: "destructive",
  high: "destructive",
  medium: "secondary",
  low: "outline",
};

export default async function ContradictionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const contradictions = await listContradictions(id);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
        {" / "}Contradictions
      </nav>
      <h1 className="mb-1 text-2xl font-semibold">Open contradictions</h1>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Detected by deterministic rules, not by a model&apos;s opinion. A
        contradiction is a flag for a human — resolve it by approving a corrected
        version with the right effective dates, never by deleting the older
        claim. Historical truth is what makes a past report explicable.
      </p>

      <KnowledgeLayerNav projectId={id} />

      {contradictions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No open contradictions</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Every approved claim agrees with the others the detector can compare
            it to.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {contradictions.map((item) => (
            <div key={item.id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={SEVERITY_TONE[item.severity] ?? "outline"}>
                  {item.severity}
                </Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  {item.detectedBy.replace(/_/g, " ")}
                </span>
              </div>
              <p className="mt-2 text-sm">{item.description}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-md border bg-secondary/20 p-2">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Claim A</p>
                  <p className="text-sm">{item.claimText}</p>
                </div>
                {item.contradictingText && (
                  <div className="rounded-md border bg-secondary/20 p-2">
                    <p className="text-xs font-medium uppercase text-muted-foreground">Claim B</p>
                    <p className="text-sm">{item.contradictingText}</p>
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Both claims remain in the knowledge graph. Any packet that
                includes either one carries this contradiction with it, and the
                agent is told not to assert the disputed point.
              </p>
              <ResolveContradiction contradictionId={item.id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
