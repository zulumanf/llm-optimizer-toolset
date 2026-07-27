import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listActiveCompanies } from "@/db/companies";
import {
  listComparisonCompanies,
  latestScoresByCompany,
  listBrandCandidates,
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

  const [comparison, scores, candidates, companies] = await Promise.all([
    listComparisonCompanies(id),
    latestScoresByCompany(id),
    listBrandCandidates(CANDIDATE_MIN_HITS),
    listActiveCompanies(),
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
