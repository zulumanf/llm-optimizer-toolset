import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Section,
  Stat,
  StatGrid,
} from "@/components/layout/page";
import { getActivePlan } from "@/lib/plans/service";

export const dynamic = "force-dynamic";

const PHASES = [
  { key: "foundation", label: "Days 0–30 · Foundation", blurb: "Fix identity and the public record. Nothing downstream works until an assistant can tell who this is." },
  { key: "authority", label: "Days 31–60 · Authority", blurb: "Build proof on the surfaces the retrieval path already reads." },
  { key: "compounding", label: "Days 61–90 · Compounding", blurb: "Plays that only work once the first two phases have landed." },
] as const;

const OWNER_TONE: Record<string, "default" | "secondary" | "outline"> = {
  operator: "default",
  client: "secondary",
  shared: "outline",
};

export default async function PlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const plan = await getActivePlan(id);

  if (!plan) {
    return (
      <PageShell>
        <PageHeader
          title="90-day program"
          crumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Plan" }]}
        />
        <EmptyState
          message="No plan composed yet. A plan is built from open gap findings — run and analyse a measurement first, then compose. An empty plan is ceremony, so none is shown."
        />
      </PageShell>
    );
  }

  const baseline = plan.baseline as {
    organicMentionRate?: number | null;
    topCompetitor?: string | null;
    topCompetitorRate?: number | null;
    citedDomains?: { domain: string; citations: number }[];
    ownDomainCited?: boolean;
    findingCount?: number;
    composedAt?: string;
  };
  const planned = plan.items.filter((i) => i.status !== "excluded");
  const excluded = plan.items.filter((i) => i.status === "excluded");
  const totalHours = planned.reduce((sum, i) => sum + i.effortHours, 0);

  return (
    <PageShell>
      <PageHeader
        title={plan.title}
        badge={<Badge variant={plan.status === "draft" ? "secondary" : "default"}>{plan.status}</Badge>}
        crumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Plan" }]}
        description={`Composed from ${baseline.findingCount ?? 0} open findings on ${baseline.composedAt ?? "—"} · ${planned.length} plays · ${totalHours.toFixed(0)}h · composer ${plan.compositionHash.slice(0, 8)}`}
      />

      {/* ---------------------------------------------------- baseline */}
      <Section
        title="Baseline at composition"
        description="Frozen so progress is measured against the picture the plan was built from, not against today's numbers."
      >
        <StatGrid>
          <Stat
            label="Organic mentions"
            value={
              baseline.organicMentionRate === null || baseline.organicMentionRate === undefined
                ? "not measured"
                : `${(baseline.organicMentionRate * 100).toFixed(0)}%`
            }
          />
          <Stat
            label={baseline.topCompetitor ?? "Leader"}
            value={
              baseline.topCompetitorRate === null || baseline.topCompetitorRate === undefined
                ? "—"
                : `${(baseline.topCompetitorRate * 100).toFixed(0)}%`
            }
          />
          <Stat label="Own domain cited" value={baseline.ownDomainCited ? "yes" : "no"} />
          <Stat
            label="Top cited surface"
            value={
              baseline.citedDomains?.[0]
                ? `${baseline.citedDomains[0].domain} (${baseline.citedDomains[0].citations}×)`
                : "—"
            }
          />
        </StatGrid>
      </Section>

      {/* ------------------------------------------------------- phases */}
      {PHASES.map((phase) => {
        const items = planned.filter((i) => i.phase === phase.key);
        if (items.length === 0) return null;
        const hours = items.reduce((sum, i) => sum + i.effortHours, 0);
        return (
          <Section key={phase.key} title={phase.label} description={`${phase.blurb} — ${hours.toFixed(0)}h across ${items.length} plays`}>
            <ol className="space-y-3">
              {items.map((item) => (
                <li key={item.playKey} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {item.position}.
                    </span>
                    <span className="font-medium">{item.title}</span>
                    <Badge variant={OWNER_TONE[item.owner] ?? "outline"}>{item.owner}</Badge>
                    <span className="text-xs text-muted-foreground">{item.effortHours}h</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{item.rationale}</p>
                  <p className="mt-2 text-xs">
                    <span className="text-muted-foreground">Measure: </span>
                    {item.measurement}
                  </p>
                  {item.sourceFindingId && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Traces to finding {item.sourceFindingId.slice(0, 8)}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </Section>
        );
      })}

      {/* ----------------------------------------------------- excluded */}
      {excluded.length > 0 && (
        <Section
          title="Not scheduled, and why"
          description="Plays whose preconditions are not met. Shown rather than dropped — a missing play should tell you what data is missing, not leave you wondering why it never appeared."
        >
          <ul className="space-y-2">
            {excluded.map((item) => (
              <li key={item.playKey} className="rounded-md border border-dashed p-3">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.exclusionReason}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <p className="mt-8 text-xs text-muted-foreground">
        Every item is composed deterministically from ranked findings — the same
        findings always produce the same plan. Measurements are movements to
        observe, never outcomes promised.
      </p>
    </PageShell>
  );
}
