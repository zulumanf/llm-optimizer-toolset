import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Section,
  Stat,
  StatGrid,
} from "@/components/layout/page";
import { listLaunches } from "@/lib/prospects/service";
import {
  marketSourceGraph,
  MIN_MARKET_CITATIONS,
} from "@/lib/citations/market";

const SOURCE_TYPE_LABELS: Record<string, string> = {
  industry_ranking: "industry ranking",
  local_press: "local press",
  client_site: "own site",
};

function sourceTypeLabel(t: string): string {
  return SOURCE_TYPE_LABELS[t] ?? t.replaceAll("_", " ");
}

export default async function MarketSourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ launch?: string }>;
}) {
  const { launch } = await searchParams;
  const launches = await listLaunches();
  const selected =
    launches.find((l) => l.id === launch) ?? launches[0] ?? null;
  const graph = selected ? await marketSourceGraph(selected.id) : null;

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Prospects", href: "/prospects" }]}
        title="What AI relies on"
        description="The domains that keep showing up as sources in this market's AI answers — where recommendations are being sourced from, and which prospects those sources represent."
        actions={
          launches.length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {launches.map((l) => (
                <Link
                  key={l.id}
                  href={`/prospects/sources?launch=${l.id}`}
                  className={`inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted ${
                    selected?.id === l.id ? "bg-muted" : ""
                  }`}
                >
                  {l.name}
                </Link>
              ))}
            </div>
          ) : undefined
        }
      />

      {!selected || !graph ? (
        <EmptyState message="No market launches yet. Create one from the Prospects page, benchmark its prospects, and the source graph builds itself from the citations." />
      ) : (
        <>
          <Section title={selected.name}>
            <StatGrid columns={4}>
              <Stat
                label="Citations"
                value={graph.totals.citations.toLocaleString()}
                hint="rows in the immutable citation ledger"
              />
              <Stat
                label="Answers measured"
                value={graph.totals.responses.toLocaleString()}
                hint="successful responses only — failures never count"
              />
              <Stat label="Benchmark runs" value={String(graph.totals.runs)} />
              <Stat
                label="Source domains"
                value={String(graph.domains.length)}
                hint={graph.domains.length >= 25 ? "top 25 shown" : undefined}
              />
            </StatGrid>
          </Section>

          {!graph.sufficient ? (
            <Section title="Not enough evidence yet">
              <EmptyState
                message={`Only ${graph.totals.citations} citations captured so far — at least ${MIN_MARKET_CITATIONS} are needed before this market's source patterns mean anything. Run more benchmarks (search-enabled providers produce citations) and come back.`}
              />
            </Section>
          ) : (
            <>
              <Section
                title="Where the answers are sourced"
                description="Companies listed appeared in answers that cited the domain — co-occurrence in the same answer, not proof the citation caused the mention."
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Domain</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Citations</TableHead>
                      <TableHead className="text-right">Answer share</TableHead>
                      <TableHead>Engines</TableHead>
                      <TableHead>Seen alongside</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {graph.domains.map((d) => (
                      <TableRow key={d.domain}>
                        <TableCell className="font-medium">
                          {d.domain}
                          {d.topUrls.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              {d.topUrls
                                .map((u) =>
                                  u.url.replace(/^https?:\/\/(www\.)?/, "")
                                )
                                .join(" · ")}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {sourceTypeLabel(d.sourceType)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {d.citations}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {(d.responseShare * 100).toFixed(0)}%
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {d.providers.join(", ")}
                        </TableCell>
                        <TableCell className="text-sm">
                          {d.companiesInCitingAnswers.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            d.companiesInCitingAnswers.map((c) => (
                              <span key={c.companyId} className="mr-2">
                                {c.name}
                                {c.recommendations > 0 && (
                                  <span className="text-muted-foreground tabular-nums">
                                    {" "}
                                    ({c.recommendations}×)
                                  </span>
                                )}
                              </span>
                            ))
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Section>

              <Section
                title="Prospect presence in the source graph"
                description="Whose content the answers cite, and who shows up in answers sourced from the big domains. A strong team absent everywhere here is the pitch."
              >
                {graph.prospects.length === 0 ? (
                  <EmptyState message="No prospects on this launch yet. Add prospects and benchmark them from the Prospects page." />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Prospect</TableHead>
                        <TableHead className="text-right">
                          Own site cited
                        </TableHead>
                        <TableHead>Appears in answers citing</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {graph.prospects.map((p) => (
                        <TableRow key={p.prospectId}>
                          <TableCell className="font-medium">
                            <Link
                              href={`/prospects/${p.prospectId}`}
                              className="hover:underline"
                            >
                              {p.businessName}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {p.ownDomainCitations > 0 ? (
                              `${p.ownDomainCitations}×`
                            ) : (
                              <span className="text-muted-foreground">
                                never
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            {p.presentInDomains.length === 0 ? (
                              <span className="text-muted-foreground">
                                absent from every top source&apos;s answers
                              </span>
                            ) : (
                              p.presentInDomains.join(", ")
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Section>
            </>
          )}
        </>
      )}
    </PageShell>
  );
}
