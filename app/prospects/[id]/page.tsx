import { notFound } from "next/navigation";
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
import { SignalDialog } from "@/components/prospects/signal-dialog";
import {
  BenchmarkLink,
  GenerateFindingsButton,
} from "@/components/prospects/benchmark-link";
import { FindingActions } from "@/components/prospects/finding-actions";
import {
  CopyAuditLink,
  PublishAuditButton,
  RevokeAuditButton,
} from "@/components/prospects/audit-actions";
import {
  ApproveDraftButton,
  GenerateDraftButton,
  RecordSentButton,
} from "@/components/prospects/draft-actions";
import {
  GenerateRecordingButton,
  RecordingStatusSelect,
} from "@/components/prospects/recording-actions";
import { NoteForm, StageControl } from "@/components/prospects/stage-control";
import {
  getProspectDetail,
  linkableRuns,
  listActivities,
  listAudits,
  listBenchmarks,
  listDrafts,
  listFindings,
  listRecordingPlans,
  listSignals,
  listStageHistory,
} from "@/lib/prospects/detail";
import { benchmarkMetrics } from "@/lib/prospects/service";

const rate = (v: number | null): string =>
  v === null ? "not measured" : `${Math.round(v * 100)}%`;

export default async function ProspectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const prospect = await getProspectDetail(id);
  if (!prospect) notFound();

  const [signals, benchmarks, findings, audits, drafts, plans, history, activities] =
    await Promise.all([
      listSignals(id),
      listBenchmarks(id),
      listFindings(id),
      listAudits(id),
      listDrafts(id),
      listRecordingPlans(id),
      listStageHistory(id),
      listActivities(id),
    ]);

  const latestBenchmark = benchmarks[0];
  const metrics = latestBenchmark ? await benchmarkMetrics(latestBenchmark.id) : null;
  const runs = prospect.companyId ? await linkableRuns(prospect.companyId) : [];
  const publishedAudit = audits.find((a) => a.status === "published");
  const primaryFinding = findings.find((f) => f.isPrimary && f.status === "approved");

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Prospects", href: "/prospects" }, { label: prospect.businessName }]}
        title={prospect.businessName}
        description={`${prospect.prospectType.replaceAll("_", " ")} · ${prospect.launchName} · ${prospect.marketName}`}
        badge={
          <>
            <Badge variant="secondary">{prospect.stage.replaceAll("_", " ")}</Badge>
            <Badge
              variant={
                prospect.conflictStatus === "clear" || prospect.conflictStatus === "override"
                  ? "outline"
                  : prospect.conflictStatus === "unchecked"
                    ? "secondary"
                    : "destructive"
              }
            >
              conflict: {prospect.conflictStatus}
            </Badge>
            {prospect.doNotContact && <Badge variant="destructive">do not contact</Badge>}
          </>
        }
        actions={<StageControl prospectId={id} currentStage={prospect.stage} />}
      />

      <Section title="Overview">
        <StatGrid columns={4}>
          <Stat label="Team leader" value={prospect.teamLeader ?? "—"} />
          <Stat label="Brokerage" value={prospect.brokerageAffiliation ?? "—"} />
          <Stat
            label="Canonical company"
            value={prospect.companyName ?? "not linked"}
            hint={prospect.companyName ? undefined : "Needed to link benchmark data"}
          />
          <Stat label="Owner" value={prospect.ownerName ?? "—"} />
        </StatGrid>
        {Object.keys(prospect.fieldProvenance).length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Provenance:{" "}
            {Object.entries(prospect.fieldProvenance)
              .map(([field, label]) => `${field} (${String(label).replaceAll("_", " ")})`)
              .join(" · ")}
          </p>
        )}
      </Section>

      <Section
        title="Authority signals"
        description="Verified real-world position — every signal keeps its source and provenance label."
        actions={<SignalDialog prospectId={id} />}
      >
        {signals.length === 0 ? (
          <EmptyState message="No authority signals yet. Record what makes this team a market leader — rankings, volume, press — with sources." />
        ) : (
          <ul className="space-y-2">
            {signals.map((s) => (
              <li key={s.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{s.kind.replaceAll("_", " ")}</Badge>
                  <Badge variant={s.provenance === "verified" ? "default" : "secondary"}>
                    {s.provenance.replaceAll("_", " ")}
                  </Badge>
                </div>
                <p className="mt-1.5">{s.label}</p>
                {s.sourceUrl && (
                  <a
                    href={s.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-muted-foreground underline"
                  >
                    {s.sourceUrl}
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="AI visibility benchmark"
        description="Read directly from the scoring engine — nothing recomputed, sample sizes always shown."
        actions={<BenchmarkLink prospectId={id} runs={runs} />}
      >
        {!prospect.companyId ? (
          <EmptyState message="Link this prospect to its canonical company (Companies registry) to attach benchmark data." />
        ) : !metrics ? (
          <EmptyState
            message={
              runs.length === 0
                ? "No completed runs have scored this company yet. Track it as a competitor in a market run first, or wait for the next scheduled scan."
                : "No benchmark linked yet. Pick a scored run above."
            }
          />
        ) : (
          <>
            {metrics.prospect ? (
              <StatGrid columns={4}>
                <Stat
                  label="Mention rate"
                  value={rate(metrics.prospect.mentionRate)}
                  hint={`n = ${metrics.prospect.sampleSize} responses`}
                />
                <Stat
                  label="Recommendation rate"
                  value={rate(metrics.prospect.recommendationRate)}
                  hint={`${metrics.run.providers.join(", ")}`}
                />
                <Stat label="Share of AI voice" value={rate(metrics.prospect.shareOfVoice)} />
                <Stat
                  label="Run"
                  value={metrics.run.label}
                  hint={`${metrics.run.promptCount} prompts · ${metrics.run.responseCount} responses`}
                />
              </StatGrid>
            ) : (
              <EmptyState message="The linked run has no scores for this company under the current scoring version." />
            )}
            {metrics.others.length > 0 && (
              <Table className="mt-4">
                <TableHeader>
                  <TableRow>
                    <TableHead>Compared entity</TableHead>
                    <TableHead className="text-right">Mention rate</TableHead>
                    <TableHead className="text-right">Recommendation rate</TableHead>
                    <TableHead className="text-right">n</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metrics.others.map((o) => (
                    <TableRow key={o.companyId}>
                      <TableCell>{o.name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {rate(o.mentionRate)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {rate(o.recommendationRate)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{o.sampleSize}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </Section>

      <Section
        title="Reality-to-AI findings"
        description="Deterministic candidates from authority signals vs measured visibility. A human approves exactly one primary finding before anything goes external."
        actions={latestBenchmark ? <GenerateFindingsButton benchmarkId={latestBenchmark.id} /> : undefined}
      >
        {findings.length === 0 ? (
          <EmptyState message="No findings yet. Link a benchmark, add authority signals, then generate candidates." />
        ) : (
          <ul className="space-y-3">
            {findings.map((f) => (
              <li key={f.id} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{f.kind.replaceAll("_", " ")}</Badge>
                  <Badge variant={f.severity === "high" ? "destructive" : "secondary"}>
                    {f.severity}
                  </Badge>
                  <Badge
                    variant={
                      f.status === "approved"
                        ? "default"
                        : f.status === "rejected"
                          ? "destructive"
                          : "secondary"
                    }
                  >
                    {f.status}
                  </Badge>
                  {f.isPrimary && <Badge>primary</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {f.responseIds.length} evidence responses
                    {f.signalIds.length > 0 ? ` · ${f.signalIds.length} signals` : ""}
                    {f.confidence !== null
                      ? ` · confidence ${Math.round(Number(f.confidence) * 100)}%`
                      : ""}
                  </span>
                </div>
                <p className="mt-2 font-medium">{f.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{f.explanation}</p>
                {f.status === "candidate" && (
                  <div className="mt-3">
                    <FindingActions findingId={f.id} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Prospect audit page"
        description="A private, snapshot-only page behind a revocable high-entropy link. Internal notes are structurally absent."
        actions={
          !publishedAudit && primaryFinding ? <PublishAuditButton prospectId={id} /> : undefined
        }
      >
        {audits.length === 0 ? (
          <EmptyState message="No audit page yet. Approve a primary finding, then publish — a secure share link is minted at publish time." />
        ) : (
          <ul className="space-y-2">
            {audits.map((a) => (
              <li key={a.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={a.status === "published" ? "default" : "secondary"}>
                      {a.status}
                    </Badge>
                    <span>{a.headline}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {a.status === "published" && a.accessToken && (
                      <>
                        <CopyAuditLink token={a.accessToken} />
                        <RevokeAuditButton auditId={a.id} />
                      </>
                    )}
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {a.viewCount} external view{a.viewCount === 1 ? "" : "s"}
                  {a.firstViewedAt
                    ? ` · first ${new Date(a.firstViewedAt).toLocaleString()} · last ${new Date(
                        a.lastViewedAt as unknown as string
                      ).toLocaleString()}`
                    : ""}
                  {a.expiresAt
                    ? ` · expires ${new Date(a.expiresAt).toLocaleString()}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Outreach"
        description="Reply-first drafts generated from the approved finding. Nothing sends from here — a human sends, then records it."
        actions={primaryFinding ? <GenerateDraftButton prospectId={id} /> : undefined}
      >
        {drafts.length === 0 ? (
          <EmptyState message="No drafts yet. Approve a primary finding first — drafts are built from approved evidence only." />
        ) : (
          <ul className="space-y-3">
            {drafts.map((d) => (
              <li key={d.id} className="rounded-md border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {d.channel.replaceAll("_", " ")} · v{d.version}
                  </Badge>
                  <Badge
                    variant={
                      d.status === "approved"
                        ? "default"
                        : d.status === "superseded"
                          ? "secondary"
                          : "outline"
                    }
                  >
                    {d.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {d.generatedBy === "system" ? "template-generated" : "operator-written"}
                    {d.sentRecordedAt
                      ? ` · sent ${new Date(d.sentRecordedAt).toLocaleString()}`
                      : ""}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {d.status === "draft" && <ApproveDraftButton draftId={d.id} />}
                    {d.status === "approved" && !d.sentRecordedAt && (
                      <RecordSentButton draftId={d.id} />
                    )}
                  </div>
                </div>
                {d.subject && <p className="mt-2 text-sm font-medium">{d.subject}</p>}
                <pre className="mt-2 whitespace-pre-wrap rounded bg-muted p-3 font-sans text-sm">
                  {d.body}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Screen-recording plan"
        description="A prospect-first storyboard for a 2–3 minute walkthrough — claims to verify are listed so nothing is improvised."
        actions={primaryFinding ? <GenerateRecordingButton prospectId={id} /> : undefined}
      >
        {plans.length === 0 ? (
          <EmptyState message="No recording plan yet — generate one from the approved finding." />
        ) : (
          <ul className="space-y-3">
            {plans.map((p) => (
              <li key={p.id} className="rounded-md border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    ~{Math.round((p.estimatedDurationSeconds ?? 180) / 60)} min ·{" "}
                    {new Date(p.createdAt).toLocaleDateString()}
                  </span>
                  <RecordingStatusSelect planId={p.id} status={p.status} />
                </div>
                <pre className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap rounded bg-muted p-3 font-sans text-sm">
                  {p.script}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Pipeline history">
        {history.length === 0 ? (
          <EmptyState message="No stage changes yet." />
        ) : (
          <ul className="space-y-1 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-xs text-muted-foreground">
                  {new Date(h.changedAt).toLocaleString()}
                </span>
                <span>
                  {h.fromStage.replaceAll("_", " ")} → {h.toStage.replaceAll("_", " ")}
                </span>
                {h.reason && <span className="text-muted-foreground">({h.reason})</span>}
                <span className="text-xs text-muted-foreground">
                  by {h.changedByName ?? "unknown"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Activity" actions={<NoteForm prospectId={id} />}>
        {activities.length === 0 ? (
          <EmptyState message="No activity yet — every material change and audit view lands here." />
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {activities.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-xs text-muted-foreground">
                  {new Date(a.occurredAt).toLocaleString()}
                </span>
                <Badge variant="outline">{a.kind.replaceAll("_", " ")}</Badge>
                <span className="text-muted-foreground">
                  {a.kind === "note"
                    ? String((a.detail as { note?: string }).note ?? "")
                    : (a.actorName ?? "external viewer")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </PageShell>
  );
}
