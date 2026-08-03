import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import {
  pendingInstructionApprovals,
  resolveInstructions,
} from "@/lib/knowledge/instructions/service";
import { Badge } from "@/components/ui/badge";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";
import {
  ApproveInstructionButton,
  NewInstructionForm,
  ReviseInstruction,
} from "@/components/knowledge/instruction-form";

export const dynamic = "force-dynamic";

export default async function InstructionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [{ instructions, excluded }, pending] = await Promise.all([
    resolveInstructions({ projectId: id }),
    pendingInstructionApprovals(id),
  ]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
        {" / "}Instructions
      </nav>
      <h1 className="mb-1 text-2xl font-semibold">Operating instructions</h1>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Rules, not facts. &ldquo;JC Luxury operates in Jersey City&rdquo; is a
        claim; &ldquo;lead with Jersey City before Hoboken&rdquo; is an
        instruction. They are versioned, scoped and effective-dated separately,
        and a packet carries them in their own labelled block so an agent cannot
        restate a rule as a client fact.
      </p>

      <KnowledgeLayerNav projectId={id} />

      <div className="mb-4">
        <NewInstructionForm projectId={id} />
      </div>

      {pending.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">Awaiting approval ({pending.length})</h2>
          <div className="space-y-2">
            {pending.map((version) => (
              <div key={version.versionId} className="rounded-lg border border-dashed p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{version.title}</span>
                  <Badge variant="outline">
                    {version.instructionType.replace(/_/g, " ")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">v{version.version}</span>
                  <ApproveInstructionButton versionId={version.versionId} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{version.body}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Active ({instructions.length})</h2>
        {instructions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-sm font-medium">No active instructions</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Packets for this client will disclose that a required instruction
              type is missing rather than assuming one.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {instructions.map((instruction) => (
              <div key={instruction.versionId} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{instruction.title}</span>
                  <Badge variant={instruction.isSafety ? "default" : "outline"}>
                    {instruction.instructionType.replace(/_/g, " ")}
                  </Badge>
                  {instruction.isSafety && <Badge variant="secondary">never truncated</Badge>}
                  <span className="text-xs text-muted-foreground">
                    v{instruction.version} · {instruction.scope} scope · priority{" "}
                    {instruction.priority}
                  </span>
                </div>
                <p className="mt-1 text-sm">{instruction.body}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Effective {instruction.effectiveFrom}
                  {instruction.effectiveUntil ? ` until ${instruction.effectiveUntil}` : ""}
                </p>
                <ReviseInstruction
                  instructionId={instruction.id}
                  currentBody={instruction.body}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-medium">Not applied ({excluded.length})</h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Recorded rather than hidden. An unapproved rule is a draft, and drafts
          do not govern agent behaviour — but an operator needs to know one
          exists.
        </p>
        {excluded.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every instruction on file is in force.
          </p>
        ) : (
          <ul className="space-y-1">
            {excluded.map((entry, index) => (
              <li key={index} className="rounded-md border border-dashed p-2 text-sm">
                <span className="font-medium">{entry.title}</span>
                <span className="text-muted-foreground"> — {entry.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
