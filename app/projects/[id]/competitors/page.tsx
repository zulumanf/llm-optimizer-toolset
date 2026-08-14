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
import { listRelationshipsForProject } from "@/lib/knowledge/entities/service";
import { RelationshipControls } from "@/components/competitors/relationship-controls";
import { headToHeadForProject, HEAD_TO_HEAD_VERSION } from "@/lib/competitors/head-to-head";
import {
  modelAgreementForProject,
  MODEL_AGREEMENT_VERSION,
  MIN_PROVIDER_SAMPLE,
  type AgreementLabel,
} from "@/lib/competitors/agreement";
import { citationProfilesForProject } from "@/lib/competitors/citation-profiles";
import { AddCompetitorDialog } from "@/components/competitors/add-competitor-dialog";
import { CompetitorRowControls } from "@/components/competitors/competitor-row-controls";
import { CandidatePanel } from "@/components/competitors/candidate-panel";

const CANDIDATE_MIN_HITS = 3;

function fmt(value: number | undefined, percent = true): string {
  if (value === undefined) return "n/a";
  return percent ? `${(value * 100).toFixed(1)}%` : value.toFixed(1);
}

function agreementBadge(label: AgreementLabel) {
  switch (label) {
    case "consensus_recommended":
      return <Badge>consensus: recommended</Badge>;
    case "consensus_mentioned":
      return <Badge variant="secondary">consensus: brought up</Badge>;
    case "majority":
      return <Badge variant="secondary">partial agreement</Badge>;
    case "divergent":
      return <Badge variant="outline" className="text-warning">assistants disagree</Badge>;
    case "single_provider":
      return <Badge variant="outline" className="text-warning">one assistant only</Badge>;
    case "absent":
      return <Badge variant="outline">absent everywhere</Badge>;
    case "insufficient":
      return <Badge variant="outline" className="text-muted-foreground">insufficient sample</Badge>;
  }
}

export default async function CompetitorsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const relationships = await listRelationshipsForProject(id);
  const [comparison, scores, candidates, companies, topSources, groups, headToHead, agreement, profiles] =
    await Promise.all([
      listComparisonCompanies(id),
      latestScoresByCompany(id),
      listBrandCandidates(id, CANDIDATE_MIN_HITS),
      listActiveCompanies(),
      listTopSources(id),
      relationshipGroups(id),
      headToHeadForProject(id),
      modelAgreementForProject(id),
      citationProfilesForProject(id),
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
                    {row.isSelf && <Badge className="ml-2">own brand</Badge>}
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

      <section className="mt-8">
        <h2 className="text-lg font-medium">Entity relationships</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Link teams to their brokerages so grouped visibility can be
          measured. Proposals need an approval before they group anything —
          an affiliation is a fact about the market, and facts get reviewed.
        </p>
        <RelationshipControls
          projectId={id}
          companies={companies.map((c) => ({ id: c.id, name: c.name }))}
          relationships={relationships}
        />
      </section>

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

      {headToHead.rows.length > 0 && headToHead.runId !== null && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Head-to-head</h2>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">
            Per-response contests on the latest scored run ({HEAD_TO_HEAD_VERSION},
            derived on read). An unranked co-mention is a tie, not a loss;
            &ldquo;n/a&rdquo; means nothing was contested.
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Competitor</TableHead>
                  <TableHead className="text-right">Contested</TableHead>
                  <TableHead className="text-right">Wins</TableHead>
                  <TableHead className="text-right">Losses</TableHead>
                  <TableHead className="text-right">Ties</TableHead>
                  <TableHead className="text-right">Win rate</TableHead>
                  <TableHead>Prompts lost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {headToHead.rows.map((row) => (
                  <TableRow key={row.companyId}>
                    <TableCell className="font-medium">
                      {row.companyName}
                      {row.archived && (
                        <Badge variant="outline" className="ml-2">archived</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{row.contested}</TableCell>
                    <TableCell className="text-right">{row.selfWins}</TableCell>
                    <TableCell className="text-right">{row.competitorWins}</TableCell>
                    <TableCell className="text-right">{row.ties}</TableCell>
                    <TableCell className="text-right">{fmt(row.winRate ?? undefined)}</TableCell>
                    <TableCell className="max-w-xs">
                      {row.losingPrompts.length === 0 ? (
                        <span className="text-xs text-muted-foreground">none</span>
                      ) : (
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {row.losingPrompts.join(" · ")}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {agreement.rows.length > 0 && agreement.runId !== null && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Model agreement</h2>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">
            Whether the assistants agree about each company on the latest
            scored run ({MODEL_AGREEMENT_VERSION}, derived on read). Agreement
            describes the pattern across assistants — it never explains why
            any assistant behaves as it does.
          </p>
          {agreement.providers.length < 2 ? (
            <div className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">
              This run tested {agreement.providers.length === 1
                ? `one provider (${agreement.providers[0]})`
                : "no providers"} — a cross-model read needs at least two.
              Run the next benchmark with two or more providers to see where
              they agree and disagree.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Company</TableHead>
                      {agreement.providers.map((provider) => (
                        <TableHead key={provider} className="text-right">
                          {provider}
                        </TableHead>
                      ))}
                      <TableHead>Read</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agreement.rows.map((row) => (
                      <TableRow key={row.companyId}>
                        <TableCell className="font-medium">
                          {row.companyName}
                          {row.isSelf && <Badge className="ml-2">you</Badge>}
                        </TableCell>
                        {row.readings.map((reading) => (
                          <TableCell
                            key={reading.provider}
                            className="text-right text-xs tabular-nums"
                          >
                            {reading.sufficient ? (
                              <>
                                {reading.mentioned}/{reading.responses} brought up
                                <br />
                                {reading.recommended}/{reading.responses} recommended
                              </>
                            ) : (
                              <span className="text-muted-foreground">
                                N={reading.responses} — insufficient
                              </span>
                            )}
                          </TableCell>
                        ))}
                        <TableCell className="max-w-sm">
                          {agreementBadge(row.label)}
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.summary}
                          </p>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Providers with fewer than {MIN_PROVIDER_SAMPLE} eligible answers
                are shown but excluded from the read.
              </p>
            </>
          )}
        </section>
      )}

      {profiles.profiles.some((p) => p.domains.length > 0) && (
        <section className="mt-8">
          <h2 className="text-lg font-medium">Citation profiles</h2>
          <p className="mb-3 mt-1 text-sm text-muted-foreground">{profiles.note}</p>
          <div className="grid gap-3 lg:grid-cols-2">
            {profiles.profiles
              .filter((p) => p.domains.length > 0 || p.isSelf)
              .map((profile) => (
                <div key={profile.companyId} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-sm font-medium">{profile.companyName}</span>
                    {profile.isSelf && <Badge>you</Badge>}
                    {profile.archived && <Badge variant="outline">archived</Badge>}
                  </div>
                  {profile.domains.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No citations attached to answers recommending this company.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {profile.domains.slice(0, 8).map((d) => (
                        <li key={d.domain} className="flex items-center gap-2 text-xs">
                          <span className="font-mono">{d.domain}</span>
                          <span className="text-muted-foreground">×{d.citations}</span>
                          {d.sourceType && <Badge variant="outline">{d.sourceType}</Badge>}
                          {!profile.isSelf &&
                            profile.sourceGap.some((g) => g.domain === d.domain) && (
                              <Badge variant="destructive">gap</Badge>
                            )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
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
