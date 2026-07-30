import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { Badge } from "@/components/ui/badge";
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
      <div className="mx-auto max-w-4xl p-6">
        <nav className="mb-3 text-sm text-muted-foreground">
          <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
          {" / "}Plan
        </nav>
        <h1 className="text-2xl font-semibold tracking-tight">90-day program</h1>
        <p className="mt-4 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No plan composed yet. A plan is built from open gap findings — run and
          analyse a measurement first, then compose. An empty plan is ceremony,
          so none is shown.
        </p>
      </div>
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
    <div className="mx-auto max-w-4xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href={`/projects/${id}`} className="hover:text-foreground">{project.name}</Link>
        {" / "}Plan
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{plan.title}</h1>
        <Badge variant={plan.status === "draft" ? "secondary" : "default"}>{plan.status}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Composed from {baseline.findingCount ?? 0} open findings on{" "}
        {baseline.composedAt ?? "—"} · {planned.length} plays ·{" "}
        {totalHours.toFixed(0)}h · composer {plan.compositionHash.slice(0, 8)}
      </p>

      {/* ---------------------------------------------------- baseline */}
      <section className="mt-6 rounded-md border p-4">
        <h2 className="text-sm font-medium">Baseline at composition</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Frozen so progress is measured against the picture the plan was built
          from, not against today&apos;s numbers.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Organic mentions</dt>
            <dd className="text-lg font-medium tabular-nums">
              {baseline.organicMentionRate === null || baseline.organicMentionRate === undefined
                ? "not measured"
                : `${(baseline.organicMentionRate * 100).toFixed(0)}%`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {baseline.topCompetitor ?? "Leader"}
            </dt>
            <dd className="text-lg font-medium tabular-nums">
              {baseline.topCompetitorRate === null || baseline.topCompetitorRate === undefined
                ? "—"
                : `${(baseline.topCompetitorRate * 100).toFixed(0)}%`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Own domain cited</dt>
            <dd className="text-lg font-medium">{baseline.ownDomainCited ? "yes" : "no"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Top cited surface</dt>
            <dd className="text-lg font-medium">
              {baseline.citedDomains?.[0]
                ? `${baseline.citedDomains[0].domain} (${baseline.citedDomains[0].citations}×)`
                : "—"}
            </dd>
          </div>
        </dl>
      </section>

      {/* ------------------------------------------------------- phases */}
      {PHASES.map((phase) => {
        const items = planned.filter((i) => i.phase === phase.key);
        if (items.length === 0) return null;
        const hours = items.reduce((sum, i) => sum + i.effortHours, 0);
        return (
          <section key={phase.key} className="mt-8">
            <h2 className="text-lg font-medium">{phase.label}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{phase.blurb}</p>
            <p className="mt-1 text-xs text-muted-foreground">{hours.toFixed(0)}h across {items.length} plays</p>
            <ol className="mt-3 space-y-3">
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
          </section>
        );
      })}

      {/* ----------------------------------------------------- excluded */}
      {excluded.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Not scheduled, and why</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Plays whose preconditions are not met. Shown rather than dropped —
            a missing play should tell you what data is missing, not leave you
            wondering why it never appeared.
          </p>
          <ul className="mt-3 space-y-2">
            {excluded.map((item) => (
              <li key={item.playKey} className="rounded-md border border-dashed p-3">
                <p className="text-sm font-medium">{item.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.exclusionReason}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-8 text-xs text-muted-foreground">
        Every item is composed deterministically from ranked findings — the same
        findings always produce the same plan. Measurements are movements to
        observe, never outcomes promised.
      </p>
    </div>
  );
}
