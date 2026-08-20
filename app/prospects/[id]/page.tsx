import { PromoteButton } from "@/components/prospects/promote-button";
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
  ExpireAuditButton,
  PublishAuditButton,
  RevokeAuditButton,
} from "@/components/prospects/audit-actions";
import {
  ApproveDraftButton,
  CancelScheduledSendButton,
  EditDraftButton,
  GenerateDraftButton,
  OpenInMailButton,
  RecordSentButton,
  ScheduleSendButton,
  SendViaGmailButton,
  type DraftContactOption,
} from "@/components/prospects/draft-actions";
import { auditUrl, brandedAuditUrl } from "@/lib/prospects/urls";
import { auditLinkForProspect } from "@/lib/prospects/links";
import { latestSenseCheckForProspect } from "@/lib/prospects/sense-check";
import { SenseCheckPanel } from "@/components/prospects/sense-check-panel";
import { EnrichmentPanel } from "@/components/prospects/enrichment-panel";
import { listEnrichmentProposals } from "@/lib/prospects/enrichment";
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
import {
  ArchiveExhibitButton,
  ExhibitDialog,
} from "@/components/prospects/exhibit-dialog";
import { listExhibits } from "@/lib/prospects/exhibits";
import { FRESHNESS_WINDOWS_DAYS, staleness } from "@/lib/prospects/constants";
import { CONFIDENCE_REVIEW_THRESHOLD } from "@/lib/constants";

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

  const draftContacts: DraftContactOption[] = contacts.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    isPrimary: c.isPrimary,
    doNotContact: c.doNotContact,
  }));

  const latestBenchmark = benchmarks[0];
  const metrics = latestBenchmark ? await benchmarkMetrics(latestBenchmark.id) : null;
  const gapView = await authorityGapForProspect(id);
  // Sense-check (spec 077): latest result for the primary finding, or null
  // when none has run; undefined = no primary finding yet (panel hidden).
  const senseCheck = findings.some((f) => f.isPrimary && f.status === "approved")
    ? await latestSenseCheckForProspect(id)
    : undefined;
  // Enrichment proposals (spec 079) — staged research awaiting review.
  const enrichmentProposals = await listEnrichmentProposals(id);
  // Branded share link (spec 076) — preferred over the raw token URL.
  const brandedLink = await auditLinkForProspect(id);
  const brandedUrl = brandedLink
    ? brandedAuditUrl(brandedLink.slug, brandedLink.key)
    : null;
  const signalLabel = new Map(gapView.signals.map((s) => [s.id, s.label]));
  const suggestion = prospect.companyId ? null : await suggestCompanyForProspect(id);
  const [diagnosis, buyingSignals, exhibits] = await Promise.all([
    diagnoseProspect(id),
    listBuyingSignals(id),
    listExhibits(id),
  ]);
  const benchmarkStaleness = latestBenchmark
    ? staleness(latestBenchmark.runStartedAt, FRESHNESS_WINDOWS_DAYS.benchmark)
    : null;

  const runs = prospect.companyId ? await linkableRuns(prospect.companyId) : [];
  const publishedAudit = audits.find((a) => a.status === "published");
  const primaryFinding = findings.find((f) => f.isPrimary && f.status === "approved");

  // The page tells the operator what to do next — one step at a time.
  const nextStep = !prospect.companyId
    ? "Create the benchmark project (button in the “What AI says today” section) — it registers this team for measurement."
    : signals.length === 0
      ? "Add proof of market strength — a ranking or sales volume with a source link."
      : !metrics
        ? "Run or link a benchmark so we can measure how often AI recommends them."
        : contacts.length === 0
          ? "Add the decision-maker as a contact — outreach goes to a person."
          : !primaryFinding
            ? "Generate findings in “The story for outreach” and approve the strongest one."
            : prospect.qualificationScore === null
              ? "Fill in the assessment checklist and compute the score."
              : !publishedAudit
                ? "Publish the shareable audit page."
                : drafts.some((d) => d.status === "approved" && !d.sentRecordedAt)
                  ? "The email is approved — send it from your mailbox, then record it here."
                  : "Draft and approve the email, then send it yourself and record it.";

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
        actions={
          <span className="inline-flex items-center gap-2">
            {prospect.stage === "contracted" && !prospect.promotedProjectId && (
              <PromoteButton prospectId={id} />
            )}
            <StageControl prospectId={id} currentStage={prospect.stage} />
          </span>
        }
      />

      <div className="rounded-md border border-primary/50 bg-primary/5 px-4 py-2.5 text-sm">
        <span className="font-medium">Next step:</span> {nextStep}
      </div>

      <div className="mt-3">
        <EnrichmentPanel
          prospectId={id}
          initial={enrichmentProposals}
          keyConfigured={Boolean(process.env.PERPLEXITY_API_KEY)}
        />
      </div>

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
        title="Proof they're good"
        description="Real-world evidence — rankings, sales volume, reviews — each with a link to where it came from. This is what makes the pitch credible."
        actions={<SignalDialog prospectId={id} />}
      >
        {signals.length === 0 ? (
          <EmptyState message="No proof recorded yet. Add what makes this team a market leader — a ranking, sales volume, press — each with a link to the source." />
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
        title="Score"
        description="One 0–100 number for how good a prospect this is — market strength, the AI visibility gap, how fixable it is, and whether we can reach them. Anything not researched yet is skipped, never guessed. Recompute after adding research."
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
              <EmptyState message="No score yet. Add proof, run a benchmark, add a contact, answer the assessment — then hit Compute score." />
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
                  label="How fixable"
                  value={
                    breakdown.fixability?.raw != null
                      ? `${Math.round(breakdown.fixability.raw)} / 100`
                      : "not researched"
                  }
                  hint="based only on what we've checked"
                />
                <Stat
                  label="Research depth"
                  value={
                    breakdown.dataConfidence != null
                      ? `${Math.round(breakdown.dataConfidence * 100)}%`
                      : "—"
                  }
                  hint="how much evidence backs this score"
                />
                <Stat
                  label="Fixable, discounted"
                  value={
                    breakdown.fixability?.adjusted != null
                      ? `${Math.round(breakdown.fixability.adjusted)} / 100`
                      : "not researched"
                  }
                  hint="fixability × research depth"
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
                          {value != null ? Math.round(value) : "not researched"}
                          {value == null && (
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              — skipped, not counted against them
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
        title="The gap: strong in the market, missing from AI"
        description="Left: how strong this team is in the real market, from the proof above. Right: how often AI actually recommends them. A big gap is the whole sales pitch."
      >
        <StatGrid columns={4}>
          <Stat
            label="Market strength"
            value={gapView.authority.score !== null ? `${Math.round(gapView.authority.score)} / 100` : "not measured"}
            hint={
              gapView.authority.confidence !== null
                ? `evidence quality ${Math.round(gapView.authority.confidence * 100)}%`
                : "add proof below to measure"
            }
          />
          <Stat
            label="AI visibility"
            value={
              gapView.visibility?.score != null
                ? `${Math.round(gapView.visibility.score)} / 100`
                : "not measured"
            }
            hint={
              gapView.visibility
                ? `from ${gapView.visibility.organicResponses} AI answers to questions that didn't name them`
                : "run a benchmark to measure"
            }
          />
          <Stat
            label="The gap"
            value={gapView.gap !== null ? `${Math.round(gapView.gap)}` : "—"}
            hint="market strength minus AI visibility — bigger = stronger pitch"
          />
          <Stat
            label="On the money questions"
            value={
              gapView.visibility?.highIntentMentionRate != null
                ? `${Math.round(gapView.visibility.highIntentMentionRate * 100)}%`
                : "not measured"
            }
            hint="how often they appear on the highest-intent questions (best listing agent, sell my home)"
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
        title="Why AI isn't recommending them"
        description="Reasons based on what the AI answers cited and what we've researched — each with a suggested fix. This becomes the service pitch."
      >
        {diagnosis.diagnoses.length === 0 ? (
          <EmptyState message="Nothing to explain yet — run a benchmark first, and the reasons they're missing from AI answers will appear here." />
        ) : (
          <ul className="space-y-2">
            {diagnosis.diagnoses.map((d) => (
              <li key={d.key} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.title}</span>
                  <Badge
                    variant={
                      d.confidence >= CONFIDENCE_REVIEW_THRESHOLD ? "default" : "secondary"
                    }
                  >
                    confidence {Math.round(d.confidence * 100)}%
                  </Badge>
                </div>
                {/* Measured fact vs reading (spec 086 epistemics) */}
                {d.observations.map((obs, j) => (
                  <p key={j} className="mt-1 text-muted-foreground">
                    <span className="font-medium text-foreground">Observed:</span> {obs}
                  </p>
                ))}
                <p className="mt-1 text-muted-foreground">
                  <span className="font-medium text-foreground">Read:</span> {d.explanation}
                </p>
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
        title="Signs they're ready to buy"
        description="Recent moves — hiring for marketing, switching brokerages, a site redesign — that suggest they'd pay for help. Every one needs a link and a date; old news counts less."
        actions={<BuyingSignalDialog prospectId={id} />}
      >
        {buyingSignals.length === 0 ? (
          <EmptyState message="None recorded yet. No signals doesn't count against them — it just isn't part of the score until we know." />
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
        title="Who to talk to"
        description="The actual people — outreach goes to a person, not a business. Each person has their own do-not-contact switch."
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
        title="What AI says today"
        description="Measured from real AI answers to buyer/seller questions — how often this team comes up, next to the competitors that do."
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
            message="Not set up for measurement yet. Hit “Create benchmark project” — it registers this team for tracking and adds the launch's other teams as competitors automatically."
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
              <EmptyState message="The linked benchmark hasn't scored this team yet — it may still be processing." />
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
        title="The story for outreach"
        description="Auto-drafted angles like “ranked #9 in the market, yet AI never mentions them” — every claim backed by captured answers. Approve exactly one; everything external is built on it."
        actions={latestBenchmark ? <GenerateFindingsButton benchmarkId={latestBenchmark.id} /> : undefined}
      >
        {findings.length === 0 ? (
          <EmptyState message="No story yet. Run a benchmark and add proof above, then hit Generate — the angles write themselves from the evidence." />
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
        title="Shareable audit page"
        description="A private web page of their results you can send them. The link can be revoked anytime; your internal notes are never on it. Attach live chats below and republish to include them."
        actions={
          <>
            <ExhibitDialog prospectId={id} />
            {!publishedAudit && primaryFinding && <PublishAuditButton prospectId={id} />}
          </>
        }
      >
        {exhibits.length > 0 && (
          <ul className="mb-3 space-y-1.5 text-sm">
            {exhibits.map((e) => (
              <li key={e.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
                <span className="text-xs uppercase text-muted-foreground">
                  {e.assistant}
                </span>
                <span className="truncate">“{e.question}”</span>
                <a
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs underline"
                >
                  open
                </a>
                <span className="text-xs text-muted-foreground">{e.capturedOn}</span>
                <div className="ml-auto">
                  <ArchiveExhibitButton exhibitId={e.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {senseCheck !== undefined && (
          <div className="mb-3">
            <SenseCheckPanel prospectId={id} initial={senseCheck} />
          </div>
        )}
        {audits.length === 0 ? (
          <EmptyState message="No audit page yet. Approve a story above, then Publish — you'll get a private link to send them." />
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
                        <CopyAuditLink url={brandedUrl ?? auditUrl(a.accessToken)} />
                        <ExpireAuditButton auditId={a.id} />
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
        title="The email"
        description="Drafted from the approved story. Nothing sends itself — you send it from your own mailbox, and the do-not-contact and suppression checks run before anything is recorded."
        actions={
          primaryFinding ? (
            <GenerateDraftButton prospectId={id} contacts={draftContacts} />
          ) : undefined
        }
      >
        {drafts.length === 0 ? (
          <EmptyState message="No email yet. Approve a story first — the draft is written from it, nothing else." />
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
                    {!d.sentRecordedAt && d.scheduledSendAt
                      ? ` · scheduled ${new Date(d.scheduledSendAt).toLocaleString()}`
                      : ""}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    {d.status === "draft" && (
                      <>
                        <EditDraftButton
                          prospectId={id}
                          draft={{
                            subject: d.subject,
                            body: d.body,
                            contactId: d.contactId,
                          }}
                          contacts={draftContacts}
                        />
                        <ApproveDraftButton draftId={d.id} />
                      </>
                    )}
                    {d.status === "approved" && !d.sentRecordedAt && (
                      <>
                        <OpenInMailButton
                          recipientEmail={d.contactEmail ?? prospect.email}
                          subject={d.subject}
                          body={d.body}
                        />
                        <RecordSentButton draftId={d.id} />
                        {d.scheduledSendAt ? (
                          <CancelScheduledSendButton draftId={d.id} />
                        ) : (
                          <>
                            <ScheduleSendButton draftId={d.id} />
                            <SendViaGmailButton draftId={d.id} />
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {!d.sentRecordedAt && d.lastSendError && (
                  <p className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">
                    Last send attempt: {d.lastSendError}
                  </p>
                )}
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
        title="Video walkthrough script"
        description="A 2–3 minute storyboard if you'd rather send a Loom with (or instead of) the email — with the claims to double-check before recording."
        actions={primaryFinding ? <GenerateRecordingButton prospectId={id} /> : undefined}
      >
        {plans.length === 0 ? (
          <EmptyState message="No script yet — generate one from the approved story." />
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

      <Section title="Stage history">
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
