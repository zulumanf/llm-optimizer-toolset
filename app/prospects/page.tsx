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
import { EmptyState, PageHeader, PageShell, Section } from "@/components/layout/page";
import { ImportDialog } from "@/components/prospects/import-dialog";
import { LaunchDialog } from "@/components/prospects/launch-dialog";
import { MarketDraftDialog } from "@/components/prospects/market-draft-dialog";
import { ProspectDialog } from "@/components/prospects/prospect-dialog";
import { DiscoverDialog } from "@/components/prospects/discover-dialog";
import { CandidateActions } from "@/components/prospects/candidate-actions";
import { PipelineGuide } from "@/components/prospects/pipeline-guide";
import { PROSPECT_STAGES } from "@/lib/prospects/constants";
import { listLaunches, listProspects } from "@/lib/prospects/service";
import {
  listDiscoveryCandidates,
  listProspectDuplicates,
} from "@/lib/prospects/discovery";
import { acquisitionFunnel } from "@/lib/prospects/funnel";
import { acquisitionScoreFeedback } from "@/lib/prospects/score-feedback";
import { openRefreshCount } from "@/lib/prospects/refresh";
import { scoreBlurb } from "@/lib/prospects/score-blurb";
import { PROSPECT_SOURCE_IDS } from "@/lib/prospects/providers/registry";
import { mockProviderAllowed } from "@/lib/ai/registry";
import { listMarkets } from "@/lib/exclusivity/service";

export default async function ProspectsPage() {
  const [launches, prospects, markets, candidates, duplicates, funnel, feedback, refreshCount] =
    await Promise.all([
      listLaunches(),
      listProspects({ limit: 100 }),
      listMarkets(),
      listDiscoveryCandidates({ status: "pending" }),
      listProspectDuplicates(),
      acquisitionFunnel(),
      acquisitionScoreFeedback(),
      openRefreshCount(),
    ]);
  const providers = PROSPECT_SOURCE_IDS.filter((id) => id !== "mock" || mockProviderAllowed());

  return (
    <PageShell>
      <PageHeader
        title="Prospects"
        description="Market launches and the account-based acquisition pipeline: benchmark evidence in, human-reviewed outreach out."
        actions={
          <>
            {refreshCount > 0 && (
              <Link
                href="/prospects/refresh-queue"
                className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
              >
                Refresh queue · {refreshCount} pending
              </Link>
            )}
            <MarketDraftDialog />
            <LaunchDialog markets={markets.map((m) => ({ id: m.id, name: m.name, parentName: m.parentName }))} />
            {/* No source adapter = no Discover button (plan 3.8): a dialog
                with an empty provider list errors on submit. CSV import and
                manual entry are the working universe sources until a real
                adapter ships. */}
            {providers.length > 0 && (
              <DiscoverDialog
                launches={launches.map((l) => ({ id: l.id, name: l.name }))}
                providers={providers}
              />
            )}
            <ImportDialog launches={launches.map((l) => ({ id: l.id, name: l.name }))} />
            <ProspectDialog launches={launches.map((l) => ({ id: l.id, name: l.name }))} />
          </>
        }
      />

      <Section
        title="Market launches"
        description="One launch per market we are pursuing for an exclusive partner."
      >
        {launches.length === 0 ? (
          <EmptyState message="No market launches yet. Create one to start researching a market — it links to the exclusivity market tree." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Launch</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Prospects</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {launches.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.name}</TableCell>
                  <TableCell>{l.marketName}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{l.status.replaceAll("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>{l.ownerName ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.prospectCount}
                    {l.targetProspectCount ? ` / ${l.targetProspectCount}` : ""}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/prospects/sources?launch=${l.id}`}
                      className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                    >
                      What AI relies on →
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title="Pipeline"
        description="The prospecting flow start to finish — the highlighted step is where this workspace is right now."
      >
        <PipelineGuide
          state={{
            hasLaunch: launches.length > 0,
            hasProspects: prospects.length > 0,
            hasBenchmarking: prospects.some(
              (p) =>
                p.qualificationScore !== null ||
                PROSPECT_STAGES.indexOf(p.stage as (typeof PROSPECT_STAGES)[number]) >=
                  PROSPECT_STAGES.indexOf("benchmarking")
            ),
            hasScore: prospects.some(
              (p) => p.qualificationScore !== null || p.qualificationOverride !== null
            ),
            hasOutreach: prospects.some(
              (p) =>
                PROSPECT_STAGES.indexOf(p.stage as (typeof PROSPECT_STAGES)[number]) >=
                PROSPECT_STAGES.indexOf("outreach_ready")
            ),
          }}
        />
      </Section>

      {funnel.totalProspects > 0 && (
        <Section
          title="Acquisition funnel"
          description={`Stage-to-stage movement across ${funnel.totalProspects} prospect(s) — ever-reached counts, not snapshots (${funnel.version}).`}
        >
          <div className="overflow-x-auto">
            <div className="flex items-end gap-1 text-xs">
              {funnel.stages
                .filter((s, i) => s.reached > 0 || i < 6)
                .map((s) => (
                  <div key={s.stage} className="min-w-20 rounded-md border p-2 text-center">
                    <p className="font-medium tabular-nums">{s.reached}</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {s.stage.replaceAll("_", " ")}
                    </p>
                    {s.conversionFromPrevious !== null && (
                      <p className="mt-0.5 tabular-nums text-muted-foreground">
                        {Math.round(s.conversionFromPrevious * 100)}%
                      </p>
                    )}
                  </div>
                ))}
            </div>
          </div>
          {funnel.exits.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Exits:{" "}
              {funnel.exits
                .map((e) => `${e.stage.replaceAll("_", " ")} (${e.count})`)
                .join(" · ")}
            </p>
          )}
          <div className="mt-3 rounded-md border p-3 text-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Score feedback ({feedback.version})
            </p>
            <ul className="mt-1.5 space-y-1">
              {feedback.recommendations.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-muted-foreground">{feedback.epilogue}</p>
          </div>
        </Section>
      )}

      {candidates.length > 0 && (
        <Section
          title="Discovery candidates"
          description="Adapter results awaiting review — nothing becomes a prospect without approval. Every candidate keeps its source, retrieval date, and confidence."
        >
          <ul className="space-y-2">
            {candidates.map((c) => (
              <li key={c.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.businessName}</span>
                  {c.payload.brokerageAffiliation && (
                    <span className="text-muted-foreground">
                      at {c.payload.brokerageAffiliation}
                    </span>
                  )}
                  <Badge variant="secondary">{c.provenance.replaceAll("_", " ")}</Badge>
                  <Badge variant="outline">
                    {c.provider} · {Math.round(c.confidence * 100)}%
                  </Badge>
                  <div className="ml-auto">
                    <CandidateActions candidateId={c.id} />
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {c.launchName}
                  {c.payload.teamLeader ? ` · ${c.payload.teamLeader}` : ""}
                  {c.payload.website ? ` · ${c.payload.website}` : ""}
                  {c.sourceUrl ? ` · source: ${c.sourceUrl}` : ""}
                  {` · retrieved ${new Date(c.retrievedAt).toLocaleDateString()}`}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {duplicates.length > 0 && (
        <Section
          title="Possible duplicates across launches"
          description="Same team appearing in two launches — link both to one canonical company to keep measurement honest."
        >
          <ul className="space-y-1 text-sm">
            {duplicates.map((d, i) => (
              <li key={i} className="rounded-md border p-2">
                <Link href={`/prospects/${d.a.id}`} className="font-medium hover:underline">
                  {d.a.businessName}
                </Link>{" "}
                <span className="text-muted-foreground">({d.a.launchName})</span> ↔{" "}
                <Link href={`/prospects/${d.b.id}`} className="font-medium hover:underline">
                  {d.b.businessName}
                </Link>{" "}
                <span className="text-muted-foreground">
                  ({d.b.launchName}) — {d.detail}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Prospects"
        description="Selectively targeted teams — every stage change is checked against exclusivity."
      >
        {prospects.length === 0 ? (
          <EmptyState message="No prospects yet. Add a leading team to a launch to begin benchmarking it." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Business</TableHead>
                <TableHead>Launch</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead>Conflict</TableHead>
                <TableHead>Next action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prospects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <Link href={`/prospects/${p.id}`} className="hover:underline">
                      {p.businessName}
                    </Link>
                    {p.doNotContact && (
                      <Badge variant="destructive" className="ml-2">
                        do not contact
                      </Badge>
                    )}
                    {scoreBlurb(p.qualificationBreakdown) && (
                      <p className="mt-0.5 text-xs font-normal text-muted-foreground">
                        {scoreBlurb(p.qualificationBreakdown)}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>{p.launchName}</TableCell>
                  <TableCell>{p.prospectType.replaceAll("_", " ")}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{p.stage.replaceAll("_", " ")}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.qualificationOverride ?? p.qualificationScore ?? "—"}
                    {p.qualificationOverride !== null && (
                      <span className="ml-1 text-xs text-muted-foreground">(override)</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        p.conflictStatus === "clear" || p.conflictStatus === "override"
                          ? "outline"
                          : p.conflictStatus === "unchecked"
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {p.conflictStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.nextAction ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </PageShell>
  );
}
