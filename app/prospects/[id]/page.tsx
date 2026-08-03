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
import Link from "next/link";
import {
  BenchmarkLink,
  CreateBenchmarkProjectButton,
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
import { ContactDialog } from "@/components/prospects/contact-dialog";
import { ContactActions } from "@/components/prospects/contact-actions";
import { ScoreActions } from "@/components/prospects/score-actions";
import { AssessmentChecklist } from "@/components/prospects/assessment-checklist";
import {
  getProspectDetail,
  linkableRuns,
  listActivities,
  listAssessments,
  listAudits,
  listBenchmarks,
  listContacts,
  listDrafts,
  listFindings,
  listRecordingPlans,
  listSignals,
  listStageHistory,
} from "@/lib/prospects/detail";
import { benchmarkMetrics } from "@/lib/prospects/service";
import { authorityGapForProspect } from "@/lib/prospects/gap";
import { suggestCompanyForProspect } from "@/lib/prospects/discovery";
import { ConfirmLinkButton } from "@/components/prospects/candidate-actions";
import { diagnoseProspect } from "@/lib/prospects/diagnose";
import { listBuyingSignals, recencyFactor } from "@/lib/prospects/buying-signals";
import {
  ArchiveBuyingSignalButton,
  BuyingSignalDialog,
} from "@/components/prospects/buying-signal-dialog";
import { FRESHNESS_WINDOWS_DAYS, staleness } from "@/lib/prospects/constants";

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

  const [
    signals,
    contacts,
    assessments,
    benchmarks,
    findings,
    audits,
    drafts,
    plans,
    history,
    activities,
  ] = await Promise.all([
    listSignals(id),
    listContacts(id),
    listAssessments(id),
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
  const gapView = await authorityGapForProspect(id);
  const signalLabel = new Map(gapView.signals.map((s) => [s.id, s.label]));
  const suggestion = prospect.companyId ? null : await suggestCompanyForProspect(id);
  const [diagnosis, buyingSignals] = await Promise.all([
    diagnoseProspect(id),
    listBuyingSignals(id),
  ]);
  const benchmarkStaleness = latestBenchmark
    ? staleness(latestBenchmark.runStartedAt, FRESHNESS_WINDOWS_DAYS.benchmark)
    : null;
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
        {suggestion && suggestion.verdict !== "none" && suggestion.companyName && (
          <div className="mt-3 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={suggestion.verdict === "match" ? "default" : "secondary"}>
                company {suggestion.verdict} · {Math.round(suggestion.confidence * 100)}%
              </Badge>
              <span>
                This prospect looks like <strong>{suggestion.companyName}</strong>
              </span>
              {(suggestion.companyId ?? suggestion.candidates[0]?.companyId) && (
                <div className="ml-auto">
                  <ConfirmLinkButton
                    prospectId={id}
                    companyId={(suggestion.companyId ?? suggestion.candidates[0]!.companyId)!}
                    companyName={suggestion.companyName}
                  />
                </div>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {suggestion.reasons.join(" ")}
            </p>
            {suggestion.brokerageCollisions.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Not proposed: {suggestion.brokerageCollisions.map((b) => b.name).join(", ")}{" "}
                (brokerage affiliation, not identity).
              </p>
            )}
          </div>
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
                  {s.scope === "global" && <Badge variant="secondary">global — not counted</Badge>}
                  {staleness(s.observedAt, FRESHNESS_WINDOWS_DAYS.authoritySignal).stale && (
                    <Badge variant="destructive">
                      stale — {staleness(s.observedAt, FRESHNESS_WINDOWS_DAYS.authoritySignal).ageDays}d old
                    </Badge>
                  )}
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
        title="Prospect score"
        description="Configurable-weight composite (spec 039); every number below traces to a component, a weight, and a version. Recompute after new signals, benchmarks, contacts, or assessments."
        actions={
          <div className="flex items-center gap-2">
            <AssessmentChecklist
              prospectId={id}
              answers={Object.fromEntries(assessments.map((a) => [a.item, a.value]))}
            />
            <ScoreActions
              prospectId={id}
              hasScore={prospect.qualificationScore !== null}
              hasOverride={prospect.qualificationOverride !== null}
            />
          </div>
        }
      >
        {(() => {
          const breakdown = prospect.qualificationBreakdown as {
            weightSet?: { name: string; version: number; weights: Record<string, number> };
            components?: Record<string, number | null>;
            missing?: string[];
            dataConfidence?: number;
            fixability?: {
              raw: number | null;
              confidence: number | null;
              adjusted: number | null;
              categories: {
                key: string;
                label: string;
                points: number;
                maxPoints: number;
                measured: boolean;
                evidence: string[];
              }[];
              flags: { flag: string; explanation: string }[];
            };
            contactabilityFlags?: string[];
            computedAt?: string;
          } | null;
          if (!breakdown) {
            return (
              <EmptyState message="No score computed yet. Add signals, link a benchmark, record contacts and assessments, then compute." />
            );
          }
          return (
            <>
              <StatGrid columns={4}>
                <Stat
                  label={prospect.qualificationOverride !== null ? "Score (overridden)" : "Score"}
                  value={String(
                    prospect.qualificationOverride ?? prospect.qualificationScore ?? "—"
                  )}
                  hint={
                    prospect.qualificationOverride !== null
                      ? `override: ${prospect.qualificationOverrideReason ?? ""} · computed ${prospect.qualificationScore ?? "—"}`
                      : breakdown.computedAt
                        ? `computed ${new Date(breakdown.computedAt).toLocaleString()}`
                        : undefined
                  }
                />
                <Stat
                  label="Fixability (raw)"
                  value={
                    breakdown.fixability?.raw != null
                      ? `${Math.round(breakdown.fixability.raw)} / 100`
                      : "not measured"
                  }
                  hint="over measured categories only"
                />
                <Stat
                  label="Data confidence"
                  value={
                    breakdown.dataConfidence != null
                      ? `${Math.round(breakdown.dataConfidence * 100)}%`
                      : "—"
                  }
                  hint="multiplies the composite"
                />
                <Stat
                  label="Fixability (adjusted)"
                  value={
                    breakdown.fixability?.adjusted != null
                      ? `${Math.round(breakdown.fixability.adjusted)} / 100`
                      : "not measured"
                  }
                  hint="raw × confidence"
                />
              </StatGrid>
              {breakdown.components && breakdown.weightSet && (
                <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                  {Object.entries(breakdown.weightSet.weights).map(([key, weight]) => {
                    const value = breakdown.components?.[key];
                    return (
                      <li key={key} className="rounded-md border p-3">
                        <div className="flex items-baseline justify-between">
                          <span className="font-medium">
                            {key.replace(/([A-Z])/g, " $1").toLowerCase()}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            ×{Math.round(weight * 100)}%
                          </span>
                        </div>
                        <p className="mt-1 tabular-nums">
                          {value != null ? Math.round(value) : "not measured"}
                          {value == null && (
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              — weight redistributed
                            </span>
                          )}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
              {breakdown.fixability && (
                <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  {breakdown.fixability.categories.map((c) => (
                    <li key={c.key} className="rounded-md border p-3">
                      <div className="flex items-baseline justify-between">
                        <span className="font-medium">{c.label}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {c.measured
                            ? `${Math.round(c.points * 10) / 10} / ${c.maxPoints}`
                            : "not measured"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {c.evidence.join(" · ")}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {(breakdown.fixability?.flags.length ?? 0) > 0 && (
                <div className="mt-3 space-y-1">
                  {breakdown.fixability!.flags.map((f) => (
                    <p key={f.flag} className="text-xs text-destructive">
                      ⚑ {f.flag.replaceAll("_", " ")} — {f.explanation}
                    </p>
                  ))}
                </div>
              )}
              {(breakdown.contactabilityFlags?.length ?? 0) > 0 && (
                <p className="mt-2 text-xs text-destructive">
                  {breakdown.contactabilityFlags!.join(" · ")}
                </p>
              )}
            </>
          );
        })()}
      </Section>

      <Section
        title="Authority vs AI visibility"
        description={`Local authority from counted signals (${gapView.authority.version}) against intent-weighted visibility from the linked benchmark (${gapView.visibility?.version ?? "no benchmark linked"}). Derived on read — nothing stored.`}
      >
        <StatGrid columns={4}>
          <Stat
            label="Local authority"
            value={gapView.authority.score !== null ? `${Math.round(gapView.authority.score)} / 100` : "not measured"}
            hint={
              gapView.authority.confidence !== null
                ? `data confidence ${Math.round(gapView.authority.confidence * 100)}%`
                : "add authority signals to measure"
            }
          />
          <Stat
            label="Valuable AI visibility"
            value={
              gapView.visibility?.score != null
                ? `${Math.round(gapView.visibility.score)} / 100`
                : "not measured"
            }
            hint={
              gapView.visibility
                ? `${gapView.visibility.organicResponses} organic responses · ${gapView.visibility.brandedExcluded} branded excluded`
                : "link a scored benchmark to measure"
            }
          />
          <Stat
            label="Visibility gap"
            value={gapView.gap !== null ? `${Math.round(gapView.gap)}` : "—"}
            hint="authority − visibility; needs both sides"
          />
          <Stat
            label="High-intent mention rate"
            value={
              gapView.visibility?.highIntentMentionRate != null
                ? `${Math.round(gapView.visibility.highIntentMentionRate * 100)}%`
                : "not measured"
            }
            hint="plain rate over tier-1/2 organic prompts"
          />
        </StatGrid>
        {gapView.authority.score !== null && (
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {gapView.authority.components.map((c) => (
              <li key={c.key} className="rounded-md border p-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{c.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {Math.round(c.points * 10) / 10} / {c.maxPoints}
                  </span>
                </div>
                {c.signalIds.length > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {c.signalIds
                      .map((sid) => signalLabel.get(sid))
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">No evidence recorded.</p>
                )}
              </li>
            ))}
          </ul>
        )}
        {gapView.authority.excluded.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            Not counted:{" "}
            {gapView.authority.excluded
              .map((e) => `${signalLabel.get(e.signalId) ?? e.signalId} (${e.reason})`)
              .join(" · ")}
          </p>
        )}
      </Section>

      <Section
        title="Diagnosis"
        description={`Why this prospect is underrepresented (${diagnosis.version}) — derived from the linked benchmark, classified citations, and recorded evidence.`}
      >
        {diagnosis.diagnoses.length === 0 ? (
          <EmptyState message="No diagnoses yet — link a scored benchmark and record research to see what's holding visibility back." />
        ) : (
          <ul className="space-y-2">
            {diagnosis.diagnoses.map((d) => (
              <li key={d.key} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.title}</span>
                  <Badge variant={d.confidence >= 0.7 ? "default" : "secondary"}>
                    confidence {Math.round(d.confidence * 100)}%
                  </Badge>
                </div>
                <p className="mt-1 text-muted-foreground">{d.explanation}</p>
                {d.affectedPrompts.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Affected prompts: {d.affectedPrompts.map((p) => `“${p}”`).join(" · ")}
                  </p>
                )}
                {d.citedDomains.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Cited: {d.citedDomains.map((c) => `${c.domain} (${c.citations}×)`).join(", ")}
                  </p>
                )}
                {d.competitors.length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Competitors: {d.competitors.join(", ")}
                  </p>
                )}
                {d.suggestedAction && (
                  <p className="mt-1.5 text-xs">
                    <span className="font-medium">Suggested action:</span> {d.suggestedAction}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Buying signals"
        description="Purchase-intent evidence — every signal carries a source and a date, and its score contribution decays with age."
        actions={<BuyingSignalDialog prospectId={id} />}
      >
        {buyingSignals.length === 0 ? (
          <EmptyState message="No buying signals recorded — the final score treats this as not measured, never as zero intent." />
        ) : (
          <ul className="space-y-2">
            {buyingSignals.map((s) => {
              const factor = recencyFactor(s.observedOn);
              return (
                <li key={s.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{s.kind.replaceAll("_", " ")}</Badge>
                    <Badge variant="secondary">{s.provenance.replaceAll("_", " ")}</Badge>
                    {factor === 0.5 && <Badge variant="secondary">aging — half weight</Badge>}
                    {factor === 0 && <Badge variant="destructive">expired — no weight</Badge>}
                    <div className="ml-auto">
                      <ArchiveBuyingSignalButton signalId={s.id} />
                    </div>
                  </div>
                  <p className="mt-1.5">{s.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    observed {s.observedOn} ·{" "}
                    <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="underline">
                      source
                    </a>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title="Contacts"
        description="Outreach goes to a person, not a business — each contact carries its own do-not-contact flag."
        actions={<ContactDialog prospectId={id} />}
      >
        {contacts.length === 0 ? (
          <EmptyState message="No contacts yet. Add the team leader or marketing decision-maker before preparing outreach." />
        ) : (
          <ul className="space-y-2">
            {contacts.map((c) => (
              <li key={c.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  {c.role && <span className="text-muted-foreground">{c.role}</span>}
                  {c.isPrimary && <Badge variant="default">primary</Badge>}
                  <Badge variant="secondary">{c.provenance.replaceAll("_", " ")}</Badge>
                  {c.doNotContact && (
                    <Badge variant="destructive">
                      do not contact{c.doNotContactReason ? ` — ${c.doNotContactReason}` : ""}
                    </Badge>
                  )}
                  <div className="ml-auto">
                    <ContactActions
                      contactId={c.id}
                      isPrimary={c.isPrimary}
                      doNotContact={c.doNotContact}
                    />
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[
                    c.email,
                    c.phone,
                    c.linkedin,
                    c.preferredChannel ? `prefers ${c.preferredChannel.replaceAll("_", " ")}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "No contact details on file."}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="AI visibility benchmark"
        description="Read directly from the scoring engine — nothing recomputed, sample sizes always shown."
        actions={
          <>
            {prospect.benchmarkProjectId ? (
              <Link
                href={`/projects/${prospect.benchmarkProjectId}`}
                className="text-sm text-muted-foreground underline hover:text-foreground"
              >
                Benchmark project →
              </Link>
            ) : (
              <CreateBenchmarkProjectButton prospectId={id} />
            )}
            <BenchmarkLink prospectId={id} runs={runs} />
          </>
        }
      >
        {!prospect.companyId && !prospect.benchmarkProjectId ? (
          <EmptyState
            message="No canonical company yet. Create a benchmark project (it registers the company and pre-tracks the launch's other prospects as competitors), or link an existing company on the record."
            action={<CreateBenchmarkProjectButton prospectId={id} />}
          />
        ) : !metrics ? (
          <EmptyState
            message={
              runs.length === 0
                ? "No completed runs have scored this company yet. Open the benchmark project to build the prompt set and start a run, or wait for a market run that tracks it."
                : "No benchmark linked yet. Pick a scored run above."
            }
          />
        ) : (
          <>
            {benchmarkStaleness?.stale && (
              <p className="mb-3 text-xs text-destructive">
                ⚑ This benchmark ran {benchmarkStaleness.ageDays} days ago — past the{" "}
                {FRESHNESS_WINDOWS_DAYS.benchmark}-day freshness window. Re-run before
                publishing; publishing anyway requires an explicit acknowledgment.
              </p>
            )}
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
                    {d.contactName ? ` · to ${d.contactName}` : ""}
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
