import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { Badge } from "@/components/ui/badge";
import { PageShell, PageHeader, EmptyState } from "@/components/layout/page";
import { ProjectTabs } from "@/components/layout/project-tabs";
import { citationGapView, type GapFilters } from "@/lib/citations/service";
import { sql } from "@/db/client";
import {
  OPPORTUNITY_STATUSES,
  ACQUISITION_PATHS,
  ACVS_STRONG_THRESHOLD,
  canTransition,
  type OpportunityStatus,
} from "@/lib/citations/constants";
import {
  DiscoverButton,
  ExplanationToggle,
  LinkPlacementDialog,
  ManageOpportunityDialog,
  PresenceCheckButton,
} from "@/components/citations/opportunity-controls";

function parseFilters(params: Record<string, string | string[] | undefined>): GapFilters {
  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  const status = one(params.status);
  const path = one(params.path);
  const minAcvs = Number(one(params.minAcvs));
  return {
    statuses:
      status && (OPPORTUNITY_STATUSES as readonly string[]).includes(status)
        ? [status as OpportunityStatus]
        : undefined,
    paths:
      path && (ACQUISITION_PATHS as readonly string[]).includes(path)
        ? [path]
        : undefined,
    clientAbsentOnly: one(params.clientAbsent) === "1",
    highIntentOnly: one(params.highIntent) === "1",
    minAcvs: Number.isFinite(minAcvs) && minAcvs > 0 ? minAcvs : undefined,
  };
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-2.5 py-0.5 text-xs ${
        active
          ? "border-foreground bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

export default async function CitationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const rawParams = await searchParams;
  const project = await getProject(id);
  if (!project) notFound();

  const filters = parseFilters(rawParams);
  const [rows, versionRows] = await Promise.all([
    citationGapView(id, filters),
    sql`
      select v.id, s.name, v.version from prompt_set_versions v
      join prompt_sets s on s.id = v.prompt_set_id
      where s.project_id = ${id} and s.archived_at is null
      order by v.frozen_at desc limit 20
    `,
  ]);
  const versions = versionRows.map((v) => ({
    id: v.id as string,
    label: `${v.name as string} v${v.version as number}`,
  }));
  const base = `/projects/${id}/citations`;
  const query = (over: Record<string, string | null>): string => {
    const next = new URLSearchParams();
    for (const key of ["status", "path", "clientAbsent", "highIntent", "minAcvs"]) {
      const v = over[key] === undefined ? rawParams[key] : over[key];
      const s = Array.isArray(v) ? v[0] : v;
      if (s) next.set(key, s);
    }
    const qs = next.toString();
    return qs ? `${base}?${qs}` : base;
  };

  return (
    <PageShell>
      <ProjectTabs projectId={id} setKey="findings" />
      <PageHeader
        title="Citation sources"
        crumbs={[
          { label: "Projects", href: "/projects" },
          { label: project.name, href: `/projects/${id}` },
          { label: "Citations" },
        ]}
        description="Third-party sources the engines cited in this project's answers, scored by observed citation value (ACVS). AI citation importance is not traditional backlink authority — a source matters here only because AI answers actually cite it. Placements are measured as experiments; co-occurrence is never a causal claim."
        actions={<DiscoverButton projectId={id} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterLink href={query({ clientAbsent: null, highIntent: null, status: null, minAcvs: null })}
          active={!filters.clientAbsentOnly && !filters.highIntentOnly && !filters.statuses && !filters.minAcvs}>
          All
        </FilterLink>
        <FilterLink href={query({ clientAbsent: filters.clientAbsentOnly ? null : "1" })}
          active={filters.clientAbsentOnly === true}>
          Client absent
        </FilterLink>
        <FilterLink href={query({ highIntent: filters.highIntentOnly ? null : "1" })}
          active={filters.highIntentOnly === true}>
          High intent
        </FilterLink>
        <FilterLink
          href={query({ minAcvs: filters.minAcvs ? null : String(ACVS_STRONG_THRESHOLD) })}
          active={filters.minAcvs !== undefined}>
          ACVS ≥ {ACVS_STRONG_THRESHOLD}
        </FilterLink>
        <FilterLink href={query({ status: filters.statuses ? null : "measuring" })}
          active={filters.statuses?.[0] === "measuring"}>
          Measuring
        </FilterLink>
      </div>

      {rows.length === 0 ? (
        <EmptyState message="No citation opportunities match. Run discovery to aggregate the citation ledger from this project's scored runs." />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{row.domain}</span>
                    <Badge variant="outline">{row.status.replace(/_/g, " ")}</Badge>
                    {row.clientPresent === false && (
                      <Badge variant="destructive">client absent</Badge>
                    )}
                    {row.clientPresent === true && (
                      <Badge variant="secondary">client present</Badge>
                    )}
                    {row.interventionId && (
                      <Link
                        href={`/projects/${id}/interventions/${row.interventionId}`}
                        className="text-xs underline underline-offset-2"
                      >
                        measuring →
                      </Link>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Path: {row.acquisitionPath.replace(/_/g, " ")} ·
                    difficulty {row.acquisitionDifficulty} · contact{" "}
                    {row.contactStatus}
                    {row.nextAction ? ` · next: ${row.nextAction}` : ""}
                  </p>
                  <div className="mt-2">
                    <ExplanationToggle lines={row.acvsExplanation ?? []} />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-2xl font-semibold tabular-nums">
                      {row.acvs === null ? "—" : row.acvs.toFixed(1)}
                    </div>
                    <div className="text-xs text-muted-foreground">ACVS</div>
                  </div>
                  <PresenceCheckButton opportunityId={row.id} />
                  {!row.interventionId &&
                    versions.length > 0 &&
                    canTransition(row.status, "measuring") && (
                      <LinkPlacementDialog
                        opportunityId={row.id}
                        domain={row.domain}
                        versions={versions}
                      />
                    )}
                  <ManageOpportunityDialog
                    opportunityId={row.id}
                    domain={row.domain}
                    status={row.status}
                    acquisitionPath={row.acquisitionPath}
                    acquisitionDifficulty={row.acquisitionDifficulty}
                    nextAction={row.nextAction}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 text-xs text-muted-foreground">
        ACVS components and weights are stored with every score
        (versioned weight set) · presence checks are live fetches, kept as
        append-only history · a won placement becomes an intervention with
        baselines and retests — its verdict decides successful vs
        inconclusive, never assumed.
      </p>
    </PageShell>
  );
}
