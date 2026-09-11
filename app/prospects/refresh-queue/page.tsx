import { EmptyState, PageHeader, PageShell, Section } from "@/components/layout/page";
import { RefreshCard } from "@/components/prospects/refresh-card";
import { listAuditRefreshCandidates } from "@/lib/prospects/refresh";

export const dynamic = "force-dynamic";

/**
 * The audit refresh queue (spec 075): every published audit with fresh
 * weekly data behind it, prepared for one reviewed click. Staff-only via the
 * segment layout. Publishing still runs the full publishAudit gates — this
 * page only collects the operator's judgment and acknowledgments.
 */
export default async function RefreshQueuePage() {
  const items = await listAuditRefreshCandidates();
  const byLaunch = new Map<string, typeof items>();
  for (const item of items) {
    const list = byLaunch.get(item.launchName) ?? [];
    list.push(item);
    byLaunch.set(item.launchName, list);
  }

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Prospects", href: "/prospects" }, { label: "Refresh queue" }]}
        title="Refresh queue"
        description="Fresh weekly data is in. Each card is a prepared audit update — review what changed, then one click republishes to the same link the prospect already has. Nothing publishes without you."
      />
      {items.length === 0 ? (
        <EmptyState message="No refreshes pending. The Monday market run prepares a card here for every published audit — nothing to review right now." />
      ) : (
        [...byLaunch.entries()].map(([launchName, launchItems]) => (
          <Section
            key={launchName}
            title={launchName}
            description={`${launchItems.length} audit${launchItems.length === 1 ? "" : "s"} with fresh data · run: ${launchItems[0]?.runLabel ?? ""}`}
          >
            <div className="grid gap-4">
              {launchItems.map((item) => (
                <RefreshCard key={item.id} item={item} />
              ))}
            </div>
          </Section>
        ))
      )}
    </PageShell>
  );
}
