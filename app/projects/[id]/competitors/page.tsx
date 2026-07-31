import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listActiveCompanies } from "@/db/companies";
import {
  listComparisonCompanies,
  latestScoresByCompany,
  listBrandCandidates,
  listTopSources,
} from "@/db/competitors";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relationshipGroups } from "@/lib/competitors/groups";
import { AddCompetitorDialog } from "@/components/competitors/add-competitor-dialog";
import { CompetitorRowControls } from "@/components/competitors/competitor-row-controls";
import { CandidatePanel } from "@/components/competitors/candidate-panel";

const CANDIDATE_MIN_HITS = 3;

function fmt(value: number | undefined, percent = true): string {
  if (value === undefined) return "n/a";
  return percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(1);
}

export default async function CompetitorsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [comparison, scores, candidates, companies, topSources, groups] =
    await Promise.all([
      listComparisonCompanies(id),
      latestScoresByCompany(id),
      listBrandCandidates(id, CANDIDATE_MIN_HITS),
      listActiveCompanies(),
      listTopSources(id),
      relationshipGroups(id),
    ]);
  const untracked = companies.filter(
    (c) => !c.isSelf && !comparison.some((k) => k.companyId === c.id)
  );

  return (
    <div className="mx-auto max-w-7xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Competitors
      </nav>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Competitors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Identical methodology for every company (docs/06). Values are from
            the latest scored run, cross-provider aggregate.
          </p>
        </div>
        {project.status === "active" && (
          <AddCompetitorDialog projectId={id} companies={untracked} />
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Company</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead className="text-right">Authority</TableHead>
              <TableHead className="text-right">SoV</TableHead>
              <TableHead className="text-right">Mention rate</TableHead>
              <TableHead className="text-right">Rec rate</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {comparison.map((row) => {
              const values = scores.get(row.companyId) ?? {};
              return (
                <TableRow key={row.companyId}>
                  <TableCell className="font-medium">
                    {row.companyName}
                    {row.isSelf && <Badge className="ml-2">Parva</Badge>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.tier === "primary" ? "secondary" : "outline"}>
                      {row.tier}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt(values.authority_score, false)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt(values.share_of_voice)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt(values.mention_rate)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmt(values.recommendation_rate)}
                  </TableCell>
                  <TableCell className="text-right">
                    {!row.isSelf && row.id && (
                      <CompetitorRowControls competitorId={row.id} tier={row.tier} />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        n/a = not measurable or insufficient data (docs/06 — never rendered as
        zero). Trend charts arrive with the specs/006 dashboard.
      </p>

      {groups.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Entity groups (agent ↔ brokerage)</h2>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">
            Approved knowledge-graph relationships bridged onto measurement
            (spec 030 batch 3). The group rate counts distinct responses
            mentioning any member — never the sum of member rates, since one
            answer often names both.
          </p>
          <div className="space-y-2">
            {groups.map((g) => (
              <div key={g.parentCompanyId} className="rounded-md border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{g.parentName}</span>
                  {g.groupMentionRate !== null && (
                    <Badge>
                      group {(g.groupMentionRate * 100).toFixed(1)}%
                      {g.sampleSize ? ` of ${g.sampleSize}` : ""}
                    </Badge>
                  )}
                </div>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                  {g.members.map((m) => (
                    <li key={m.companyId}>
                      {m.name}{" "}
                      <span className="text-xs">
                        ({m.relationshipType.replace(/_/g, " ")}
                        {m.mentionRate !== null
                          ? ` · ${(m.mentionRate * 100).toFixed(1)}%`
                          : ""}
                        )
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {topSources.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Sources influencing answers</h2>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">
            Domains the engines cited across this client&apos;s runs
            (project-scoped registry, deterministic classifier v1). Owned and
            competitor labels are relative to this client&apos;s tracked set.
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Relationship</TableHead>
                  <TableHead className="text-right">Citations</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topSources.map((s) => (
                  <TableRow key={s.domain}>
                    <TableCell className="font-medium">{s.domain}</TableCell>
                    <TableCell>
                      {s.sourceType ? (
                        <Badge variant="outline">{s.sourceType}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          unclassified
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.relationship === "owned" ? (
                        <Badge>owned</Badge>
                      ) : s.relationship === "competitor" ? (
                        <Badge variant="destructive">competitor</Badge>
                      ) : s.relationship ? (
                        <Badge variant="secondary">{s.relationship}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{s.citationCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {candidates.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">
            Unrecognized brands (≥{CANDIDATE_MIN_HITS} hits)
          </h2>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">
            Detected in answers but matching no tracked alias. Track to create
            the company, add it here, and backfill recent runs.
          </p>
          <CandidatePanel projectId={id} candidates={candidates} />
        </section>
      )}
    </div>
  );
}
