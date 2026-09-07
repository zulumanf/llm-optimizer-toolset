import Link from "next/link";
import {
  PageShell,
  PageHeader,
  Section,
  StatGrid,
  Stat,
  EmptyState,
} from "@/components/layout/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { getInternalProject } from "@/db/projects";
import { getSubjectCompany } from "@/db/companies";
import { subjectScoreHistory, citationSupport } from "@/db/dashboard";
import { valuableVisibility } from "@/lib/prospects/benchmark";
import { runCoverage } from "@/lib/scoring/coverage";
import { formatDate } from "@/lib/format";

function pct(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "not measured"
    : `${(value * 100).toFixed(1)}%`;
}

interface RunRow {
  runId: string;
  label: string;
  startedAt: Date;
  metrics: Record<string, number>;
}

export default async function DogfoodPage() {
  const project = await getInternalProject();

  if (!project) {
    return (
      <PageShell>
        <PageHeader
          title="RecommendedFirst dogfood"
          description="We run the same measurement and optimization system on ourselves that we use for clients."
        />
        <EmptyState message="RecommendedFirst isn't onboarded yet. Run `npx tsx scripts/onboard-recommendedfirst.ts` to create the internal project and its frozen prompt universe, then start the baseline run." />
      </PageShell>
    );
  }

  const [subject, history] = await Promise.all([
    getSubjectCompany(project.id),
    subjectScoreHistory(project.id),
  ]);

  // Pivot score rows into per-run rows, oldest first. The earliest scored
  // run is the baseline — derived from immutable runs, never marked by hand.
  const byRun = new Map<string, RunRow>();
  for (const row of history) {
    let run = byRun.get(row.runId);
    if (!run) {
      run = { runId: row.runId, label: row.runLabel, startedAt: row.startedAt, metrics: {} };
      byRun.set(row.runId, run);
    }
    run.metrics[row.metric] = Number(row.value);
  }
  const runs = [...byRun.values()];
  const baseline = runs[0] ?? null;
  const current = runs[runs.length - 1] ?? null;

  const [valuable, coverage, support] = current
    ? await Promise.all([
        subject ? valuableVisibility(current.runId, subject.id) : Promise.resolve(null),
        runCoverage(current.runId),
        subject ? citationSupport(current.runId, subject.id) : Promise.resolve(null),
      ])
    : [null, null, null];

  // Unbranded prompt coverage: category segments minus the branded controls.
  const unbrandedCoverage = coverage
    ?.filter((r) => r.dimension === "category" && r.segment !== "branded")
    .reduce(
      (acc, r) => ({
        prompts: acc.prompts + r.promptCount,
        mentioned: acc.mentioned + r.mentionedPrompts,
      }),
      { prompts: 0, mentioned: 0 }
    );

  const mentionDelta =
    runs.length >= 2 &&
    baseline?.metrics.mention_rate !== undefined &&
    current?.metrics.mention_rate !== undefined
      ? current.metrics.mention_rate - baseline.metrics.mention_rate
      : null;

  const tabs = [
    { href: "prompts", label: "Prompts" },
    { href: "runs", label: "Runs & evidence" },
    { href: "competitors", label: "Competitors" },
    { href: "citations", label: "Citations" },
    { href: "gaps", label: "Gaps" },
    { href: "interventions", label: "Interventions" },
    { href: "technical", label: "Technical" },
    { href: "reports", label: "Reports" },
  ];

  return (
    <PageShell>
      <PageHeader
        title="RecommendedFirst dogfood"
        badge={<Badge variant="secondary">internal</Badge>}
        description="We run the same measurement and optimization system on ourselves that we use for clients. Branded control prompts never count toward these rates."
        actions={
          <Link
            href={`/projects/${project.id}/runs`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            {runs.length === 0 ? "Run the baseline" : "Run a new snapshot"}
          </Link>
        }
      />

      {runs.length === 0 ? (
        <EmptyState
          message="No scored runs yet. Start the first run against the frozen prompt set — once it completes and is scored, it becomes the permanent baseline."
          action={
            <Link
              href={`/projects/${project.id}/runs`}
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              Go to runs
            </Link>
          }
        />
      ) : (
        <>
          <Section
            title="Where we stand"
            description={
              current
                ? `Latest scored run: ${current.label} (${formatDate(current.startedAt)})`
                : undefined
            }
          >
            <StatGrid columns={3}>
              <Stat
                label="Unbranded visibility"
                value={pct(valuable?.weightedMentionRate)}
                hint={
                  valuable
                    ? `intent-weighted, ${valuable.organicResponses} answers · ${valuable.brandedExcluded} branded excluded`
                    : undefined
                }
              />
              <Stat
                label="High-intent visibility"
                value={pct(valuable?.highIntentMentionRate)}
                hint="tier 1–2 prompts only"
              />
              <Stat
                label="Prompt coverage"
                value={
                  unbrandedCoverage && unbrandedCoverage.prompts > 0
                    ? `${unbrandedCoverage.mentioned} of ${unbrandedCoverage.prompts}`
                    : "not measured"
                }
                hint="unbranded prompts where we appear at least once"
              />
              <Stat
                label="Independent citation support"
                value={
                  support && support.validResponses > 0
                    ? `${support.independentlySupported} of ${support.validResponses}`
                    : "not measured"
                }
                hint="answers mentioning us that also cite a source we don't own"
              />
              <Stat
                label="Share of voice"
                value={pct(current?.metrics.share_of_voice ?? null)}
                hint="of all tracked-company mentions"
              />
              <Stat
                label="Change vs baseline"
                value={
                  mentionDelta === null
                    ? "insufficient history"
                    : `${mentionDelta >= 0 ? "+" : ""}${(mentionDelta * 100).toFixed(1)} pts`
                }
                hint={
                  mentionDelta === null
                    ? "needs at least two scored runs"
                    : `mention rate since ${formatDate(baseline!.startedAt)} — observed change, not attributed to any single intervention`
                }
              />
            </StatGrid>
          </Section>

          <Section
            title="Visibility over runs"
            description="Every scored run against the frozen prompt universe. The first is the permanent baseline."
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Mention rate</TableHead>
                  <TableHead className="text-right">Recommendation rate</TableHead>
                  <TableHead className="text-right">Share of voice</TableHead>
                  <TableHead className="text-right">Authority</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run, i) => (
                  <TableRow key={run.runId}>
                    <TableCell>
                      <Link
                        href={`/projects/${project.id}/runs/${run.runId}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {run.label}
                      </Link>
                      {i === 0 && (
                        <Badge variant="outline" className="ml-2">
                          baseline
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{formatDate(run.startedAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(run.metrics.mention_rate ?? null)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(run.metrics.recommendation_rate ?? null)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {pct(run.metrics.share_of_voice ?? null)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.metrics.authority_score !== undefined
                        ? run.metrics.authority_score.toFixed(1)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      )}

      <Section
        title="Deep dives"
        description="Everything else runs on the standard project surfaces — same tools we point at clients."
      >
        <div className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={`/projects/${project.id}/${tab.href}`}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </Section>
    </PageShell>
  );
}
