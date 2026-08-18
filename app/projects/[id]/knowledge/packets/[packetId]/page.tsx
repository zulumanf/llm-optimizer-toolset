import { PageHeader, PageShell } from "@/components/layout/page";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { explainPacket } from "@/lib/knowledge/context/builder";
import { Badge } from "@/components/ui/badge";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";

export const dynamic = "force-dynamic";

const PRIORITY_LABEL: Record<number, string> = {
  1: "task objective",
  2: "safety instruction",
  3: "approved claim",
  4: "required evidence",
  5: "contradiction",
  6: "workflow state",
  7: "strategy",
  8: "historical",
  9: "optional",
};

export default async function PacketInspector({
  params,
}: {
  params: Promise<{ id: string; packetId: string }>;
}) {
  const { id, packetId } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  // Client scope before anything else: a packet id from another client must
  // not resolve here, whatever the URL says.
  const [owner] = await sql`
    select project_id, expires_at, withheld_claim_ids, required_disclaimers
    from evidence_packets where id = ${packetId}
  `;
  if (!owner || owner.projectId !== id) notFound();

  const explanation = await explainPacket(packetId);
  const withheld = (owner.withheldClaimIds as string[]) ?? [];
  const disclaimers = (owner.requiredDisclaimers as string[]) ?? [];
  const expiresAt = owner.expiresAt ? String(owner.expiresAt) : null;
  const expired = expiresAt !== null && new Date(expiresAt) < new Date();

  const budgetUse =
    explanation.tokenBudget > 0
      ? Math.round((explanation.tokenCount / explanation.tokenBudget) * 100)
      : null;

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Packets", href: `/projects/${id}/knowledge/packets` }, { label: "inspector" }]}
        title="Packet inspector"
        description={
          <>
        <span className="font-medium">{explanation.templateKey}</span> ·{" "}
        {explanation.tokenCount.toLocaleString()} of{" "}
        {explanation.tokenBudget.toLocaleString()} tokens
        {budgetUse !== null && ` (${budgetUse}% of budget)`} ·{" "}
        {explanation.included.length} items included, {explanation.excluded.length} excluded
        {expired && " · expired for execution (readable for audit)"}
          </>
        }
      />

      <KnowledgeLayerNav projectId={id} />

      {explanation.missingContext.length > 0 && (
        <section className="mb-6 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <h2 className="mb-1 text-sm font-medium">Known gaps disclosed to the agent</h2>
          <p className="mb-2 text-xs text-muted-foreground">
            These were carried <em>into</em> the packet. An agent that knows a
            fact is missing can say so; one that does not will fill the gap.
          </p>
          <ul className="space-y-1 text-sm">
            {explanation.missingContext.map((gap, index) => (
              <li key={index}>
                <span className="font-mono text-xs text-muted-foreground">{gap.kind}</span>{" "}
                {gap.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      {disclaimers.length > 0 && (
        <section className="mb-6 rounded-md border p-3">
          <h2 className="mb-1 text-sm font-medium">Required disclaimers</h2>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {disclaimers.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-medium">
          Included ({explanation.included.length})
        </h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Every item names why it is here — a deterministic rule, or a retrieval
          score. Nothing is included because it &ldquo;seemed relevant&rdquo;.
        </p>
        <div className="space-y-1">
          {explanation.included.map((item, index) => (
            <div key={`${item.itemRef}-${index}`} className="rounded-md border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{item.itemType.replace(/_/g, " ")}</Badge>
                <span className="text-sm">{item.label || item.itemRef}</span>
                <span className="text-xs text-muted-foreground">
                  P{item.priorityClass} · {PRIORITY_LABEL[item.priorityClass] ?? "other"} ·{" "}
                  {item.tokenCost} tokens
                </span>
                {item.freshnessStatus && item.freshnessStatus !== "current" && (
                  <Badge variant="secondary">{item.freshnessStatus.replace(/_/g, " ")}</Badge>
                )}
                {item.privacyStatus && item.privacyStatus !== "public" && (
                  <Badge variant="outline">{item.privacyStatus.replace(/_/g, " ")}</Badge>
                )}
                {item.priorityClass <= 5 && <Badge>never truncated</Badge>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{item.selectionReason}</p>
              {item.exclusionReason && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                  {item.exclusionReason}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-lg font-medium">
          Excluded ({explanation.excluded.length})
        </h2>
        <p className="mb-2 text-sm text-muted-foreground">
          Dropped by the token budget, and recorded rather than lost. This is why
          &ldquo;why is that fact missing?&rdquo; always has a stored answer.
        </p>
        {explanation.excluded.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing was dropped — everything selected fitted the budget.
          </p>
        ) : (
          <div className="space-y-1">
            {explanation.excluded.map((item, index) => (
              <div key={`${item.itemRef}-${index}`} className="rounded-md border border-dashed p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.itemType.replace(/_/g, " ")}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {item.label || item.itemRef}
                  </span>
                  <span className="text-xs text-muted-foreground">{item.tokenCost} tokens</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.exclusionReason ?? "no reason recorded"}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-lg font-medium">Withheld by privacy ({withheld.length})</h2>
        <p className="text-sm text-muted-foreground">
          {withheld.length === 0
            ? "No approved claim was withheld from this audience."
            : `${withheld.length} approved claim${withheld.length === 1 ? " was" : "s were"} withheld because this packet's audience may not see their privacy class. The omission is recorded here rather than being silent.`}
        </p>
      </section>
    </PageShell>
  );
}
