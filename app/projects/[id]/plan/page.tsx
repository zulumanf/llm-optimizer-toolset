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
import {
  ApprovePlanButton,
  ComposePlanButton,
} from "@/components/plans/plan-actions";
import {
  ActivatePlanItemButton,
  DropPlanItemButton,
} from "@/components/plans/plan-item-actions";

export const dynamic = "force-dynamic";

const PHASES = [
  {
    key: "foundation",
    label: "Days 0–30 · Get found correctly",
    blurb: "Make sure AI knows who you are. Nothing else works until it does.",
  },
  {
    key: "authority",
    label: "Days 31–60 · Build proof",
    blurb: "Put evidence where AI already looks.",
  },
  {
    key: "compounding",
    label: "Days 61–90 · Compound and check",
    blurb: "Work that only pays off once the first two phases have landed.",
  },
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
        <div className="mt-4 flex justify-center">
          <ComposePlanButton projectId={id} supersedes={false} />
        </div>
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
        actions={
          plan.status === "draft" ? (
            <>
              <ComposePlanButton projectId={id} supersedes />
              <ApprovePlanButton planId={plan.id} />
            </>
          ) : (
            <>
              <ComposePlanButton projectId={id} supersedes />
              <a
                href={`/api/plans/${plan.id}/export?format=html`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Preview for client
              </a>
              <a
                href={`/api/plans/${plan.id}/export`}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Download .md
              </a>
            </>
          )
        }
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
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium tabular-nums text-muted-foreground">
                      {item.position}.
                    </span>
                    <span className="text-sm font-medium">{item.title}</span>
                    <Badge variant={OWNER_TONE[item.owner] ?? "outline"}>{item.owner}</Badge>
                    <span className="text-xs text-muted-foreground">{item.effortHours}h</span>
                    {item.status !== "planned" && (
                      <Badge variant={item.status === "done" ? "default" : "secondary"}>
                        {item.status.replaceAll("_", " ")}
                      </Badge>
                    )}
                    {plan.status === "approved" && item.id && item.status === "planned" && (
                      <span className="ml-auto flex items-center gap-1">
                        <ActivatePlanItemButton planItemId={item.id} />
                        <DropPlanItemButton planItemId={item.id} />
                      </span>
                    )}
                  </div>

                  <p className="mt-2 text-sm">{item.rationale}</p>

                  {item.steps.length > 0 && (
                    <ul className="mt-3 space-y-1.5">
                      {item.steps.map((step) => (
                        <li key={step} className="flex gap-2 text-sm text-muted-foreground">
                          <span aria-hidden="true" className="select-none">•</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">How we check: </span>
                    {item.measurement}
                  </p>
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
