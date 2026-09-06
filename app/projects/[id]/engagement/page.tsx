import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader, PageShell, Section, Stat, StatGrid } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  AccessStatusPicker,
  ActionButton,
  BillingDialog,
  BlockDialog,
  ClientDecisionDialog,
  CloseDialog,
  ContextItemDialog,
  ContractDialog,
  MarketDefinitionDialog,
  NewWorkItemDialog,
  PermissionToggles,
  ProvenanceDialog,
  RecordMeasurementDialog,
  RenewDialog,
  RenewalStatusButtons,
  SignClientDialog,
  StartOnboardingDialog,
  UnblockDialog,
  UpdateSentDialog,
} from "@/components/engagements/controls";
import { activateExclusivity, freezeBaseline, markActive, pauseMarketOutreach } from "@/app/projects/[id]/engagement/actions";
import { sql } from "@/db/client";
import { getProject } from "@/db/projects";
import { getCurrentUser } from "@/lib/auth";
import { engagementOverview, marketOutreachConflicts } from "@/lib/engagements/service";
import { daysBetween, todayIso } from "@/lib/engagements/rules";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const human = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ");

const STAGE_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  signed: "secondary",
  onboarding: "secondary",
  active: "default",
  renewal_review: "default",
  renewed: "outline",
  completed: "outline",
  churned: "destructive",
};

/**
 * The paying client's one page (spec 131): status, next action, onboarding,
 * blockers, approvals, work with provenance, what changed, baseline and
 * remeasurement, communication, billing, exclusivity, renewal — without
 * hopping screens. Derived from canonical rows; nothing here is typed "done".
 */
export default async function EngagementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [project, user] = await Promise.all([getProject(id), getCurrentUser()]);
  if (!project) notFound();
  const view = await engagementOverview(id);

  if (!view) {
    const [linked] = await sql`
      select id, business_name, stage from prospects
      where (promoted_project_id = ${id} or benchmark_project_id = ${id}) and archived_at is null
      order by updated_at desc limit 1
    `;
    return (
      <PageShell>
        <PageHeader crumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${id}` }, { label: "Engagement" }]} title="Engagement" description="No signed engagement is recorded for this client yet." />
        <EmptyState
          message={
            linked
              ? `Prospect "${linked.businessName}" (${human(linked.stage as string)}) points at this project. Record the signed terms to start the client lifecycle — nothing is sent or charged.`
              : "Sign a client from its prospect record: the prospect id is on the prospect page. Recording the signed terms reserves the territory and plans the remeasurements."
          }
          action={<SignClientDialog projectId={id} prospectId={(linked?.id as string | undefined) ?? null} defaultStart={todayIso()} />}
        />
      </PageShell>
    );
  }

  const e = view.engagement;
  const today = todayIso();
  const daysLeft = daysBetween(today, e.endsOn);
  const baseline = view.measurements.find((m) => m.role === "baseline" && m.status === "frozen");
  const plannedSlots = view.measurements.filter((m) => m.status === "planned").map((m) => ({ id: m.id, role: m.role, scheduledFor: m.scheduledFor }));
  const outreachConflicts = await marketOutreachConflicts(e.id);
  const isAdmin = user.role === "admin";
  const evidenceOptions = baseline?.snapshot
    ? baseline.snapshot.questions
        .filter((q) => q.responseIds.length > 0)
        .slice(0, 40)
        .map((q) => ({ kind: "response", refId: q.responseIds[0]!, label: `${q.text.slice(0, 70)} (${q.subjectRecommended} of ${q.answerCount})` }))
    : [];
  const openApprovals = view.work.filter((t) => t.clientApproval === "required");
  const blocked = view.work.filter((t) => t.blockedReason);
  const current = view.work.filter((t) => (t.status === "in_progress" || t.status === "approved" || t.status === "suggested") && !t.blockedReason);

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${id}` }, { label: "Engagement" }]}
        title={`${project.name} — engagement`}
        badge={<Badge variant={STAGE_VARIANT[view.derivedStage] ?? "outline"}>{human(view.derivedStage)}</Badge>}
        description={
          <>
            <span className="block">{e.marketName} · {formatDate(new Date(`${e.startsOn}T12:00:00Z`))} → {formatDate(new Date(`${e.endsOn}T12:00:00Z`))} ({daysLeft >= 0 ? `${daysLeft} days left` : `ended ${-daysLeft} days ago`}) · {usd(e.monthlyFeeUsd)}/month · {usd(e.totalValueUsd)} total</span>
            {e.primaryContactName && <span className="block text-xs">Primary contact: {e.primaryContactName}</span>}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {view.derivedStage === "signed" && <StartOnboardingDialog projectId={id} engagementId={e.id} ready={view.commercial.ready} />}
            {view.derivedStage === "onboarding" && <ActionButton variant="default" label="Mark active" onClick={markActive.bind(null, id, { engagementId: e.id })} />}
            {(view.derivedStage === "active" || view.derivedStage === "renewal_review") && isAdmin && (
              <RenewDialog projectId={id} engagementId={e.id} endsOn={e.endsOn} monthly={e.monthlyFeeUsd} total={e.totalValueUsd} />
            )}
            {isAdmin && (view.derivedStage === "active" || view.derivedStage === "renewal_review" || view.derivedStage === "onboarding" || view.derivedStage === "signed") && (
              <CloseDialog projectId={id} engagementId={e.id} />
            )}
          </div>
        }
      />
      <Card className="mt-4 border-primary/40">
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Next action</p>
          <p className="mt-1 text-sm font-medium">{view.nextAction}</p>
        </CardContent>
      </Card>

      <Section title="Status at a glance">
        <StatGrid columns={4}>
          <Stat label="Contract" value={human(e.contractStatus)} hint={e.contractRef ?? "no reference"} />
          <Stat label="Payments received" value={usd(view.billing.receivedCents / 100)} hint={`${usd(view.billing.invoicedCents / 100)} invoiced · ${view.billing.overdueCount} overdue`} />
          <Stat label="Exclusivity" value={human(e.exclusivityStatus)} hint={e.marketDefinitionConfirmedAt ? "market definition confirmed" : "market definition NOT confirmed"} />
          <Stat label="Renewal" value={human(view.renewalStatus)} hint={`review ${e.renewalReviewOn}`} />
          <Stat label="Baseline" value={baseline?.snapshot ? `${baseline.snapshot.subject.recommendedCount} of ${baseline.snapshot.answerCount}` : "not frozen"} hint={baseline?.snapshot ? `${baseline.snapshot.provider} · ${baseline.snapshot.questionCount} questions` : "freeze from the pre-sale benchmark"} />
          <Stat label="Next remeasurement" value={view.nextMeasurement?.scheduledFor ?? "none"} hint={view.nextMeasurement ? human(view.nextMeasurement.role) : "schedule one"} />
          <Stat label="Last client update" value={view.lastClientUpdate ? formatDate(view.lastClientUpdate.at) : "never"} hint={view.lastClientUpdate?.channel ?? "weekly cadence"} />
          <Stat label="Portal access" value={String(view.portalGrants)} hint="client viewer grants" />
        </StatGrid>
        <div className="mt-3 flex flex-wrap gap-2">
          {view.signals.map((s) => (
            <Badge key={s.key} variant={s.state === "ok" ? "outline" : s.state === "waiting_client" ? "secondary" : "destructive"}>
              {s.label}: {s.detail}
            </Badge>
          ))}
        </div>
      </Section>

      <Section
        title="Onboarding checklist"
        description="Derived from the record — complete only when every line holds."
        actions={
          <>
            <ContractDialog projectId={id} engagementId={e.id} />
            <BillingDialog projectId={id} engagementId={e.id} defaultAmount={e.monthlyFeeUsd} />
            <MarketDefinitionDialog projectId={id} engagementId={e.id} current={e.marketDefinition} marketName={e.marketName} />
            {e.exclusivityStatus === "reserved" && <ActionButton label="Activate exclusivity" onClick={activateExclusivity.bind(null, id, { engagementId: e.id })} />}
            {!baseline && <ActionButton label="Freeze baseline" onClick={freezeBaseline.bind(null, id, { engagementId: e.id })} />}
          </>
        }
      >
        <ul className="divide-y rounded-md border text-sm">
          {view.checklist.map((c) => (
            <li key={c.key} className="flex items-start justify-between gap-3 p-3">
              <div>
                <p className="font-medium">{c.label}</p>
                <p className="text-xs text-muted-foreground">{c.detail}</p>
              </div>
              <Badge variant={c.done ? "outline" : "destructive"}>{c.done ? "done" : "open"}</Badge>
            </li>
          ))}
        </ul>
        {e.marketDefinition && <p className="mt-2 text-xs text-muted-foreground">Market definition: {e.marketDefinition}</p>}
        {!view.commercial.ready && <p className="mt-2 text-xs text-destructive">Commercial gate: {view.commercial.reasons.join(" ")}</p>}
      </Section>

      <Section title="Client context" description="What the client told us vs what the public evidence shows. Access is delegated; no credentials live here." actions={<ContextItemDialog projectId={id} engagementId={e.id} />}>
        {view.context.length === 0 ? (
          <EmptyState message="No context yet. Capture top neighborhoods, priorities, competitors they care about, owned assets and the access we need." />
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {view.context.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant="outline">{human(c.kind)}</Badge>
                  <span className="font-medium">{c.label}</span>
                  <Badge variant={c.provenance === "client_priority" ? "default" : "secondary"}>{human(c.provenance)}</Badge>
                  {c.sourceRef && <span className="truncate text-xs text-muted-foreground">{c.sourceRef}</span>}
                </div>
                {c.kind === "access" && c.accessStatus && <AccessStatusPicker projectId={id} itemId={c.id} value={c.accessStatus} />}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Needs the client" description="Approvals and blockers waiting on them — these are not late.">
        {openApprovals.length + blocked.length === 0 ? (
          <EmptyState message="Nothing is waiting on the client." />
        ) : (
          <ul className="space-y-2 text-sm">
            {openApprovals.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="font-medium">{t.title}</p>
                  <p className="text-xs text-muted-foreground">Client approval required{t.afterState ? ` · proposed: ${t.afterState}` : ""}{t.targetUrl ? ` · ${t.targetUrl}` : ""}</p>
                </div>
                <ClientDecisionDialog projectId={id} taskId={t.id} />
              </li>
            ))}
            {blocked.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="font-medium">{t.title}</p>
                  <p className="text-xs text-muted-foreground">Blocked · {human(t.blockedReason)}{t.blockedNote ? ` — ${t.blockedNote}` : ""}</p>
                </div>
                <UnblockDialog projectId={id} taskId={t.id} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Work"
        description="Observation → hypothesis → change → proof. Approve/start/complete on the Tasks tab."
        actions={
          <>
            <NewWorkItemDialog projectId={id} evidence={evidenceOptions} />
            <Link href={`/projects/${id}/tasks`} className="text-sm underline-offset-2 hover:underline">Tasks tab</Link>
          </>
        }
      >
        {current.length === 0 ? (
          <EmptyState message="No open work item. Freeze the baseline, then add the first evidence-backed items." />
        ) : (
          <ul className="space-y-2 text-sm">
            {current.map((t) => (
              <li key={t.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">{t.title}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge variant="outline">{t.status}</Badge>
                      {t.confidence && <Badge variant="secondary">{human(t.confidence)}</Badge>}
                      {t.control && <Badge variant="secondary">{human(t.control)}</Badge>}
                      <Badge variant={t.scope === "in_scope" ? "outline" : "destructive"}>{human(t.scope)}</Badge>
                      <Badge variant={t.clientApproval === "not_required" ? "outline" : t.clientApproval === "approved" ? "secondary" : "destructive"}>approval: {human(t.clientApproval)}</Badge>
                      <Badge variant={t.evidenceCount > 0 ? "outline" : "destructive"}>{t.evidenceCount} evidence</Badge>
                      {t.clientVisible && <Badge variant="outline">client-visible</Badge>}
                    </div>
                    {t.observation && <p className="mt-2 text-xs"><span className="text-muted-foreground">Observation:</span> {t.observation}</p>}
                    {t.hypothesis && <p className="text-xs"><span className="text-muted-foreground">Hypothesis:</span> {t.hypothesis}</p>}
                    {t.targetUrl && <p className="text-xs text-muted-foreground">{t.targetUrl}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <ProvenanceDialog projectId={id} task={{ id: t.id, observation: t.observation, hypothesis: t.hypothesis, confidence: t.confidence, control: t.control, scope: t.scope, clientApproval: t.clientApproval, targetUrl: t.targetUrl, beforeState: t.beforeState, afterState: t.afterState, measurementNote: null }} />
                    <BlockDialog projectId={id} taskId={t.id} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="What changed" description="Completed work with before/after and where — the record the remeasurement is read against.">
        {view.changes.length === 0 ? (
          <EmptyState message="No completed change yet. The change log fills as tasks complete with their before/after state." />
        ) : (
          <ul className="space-y-2 text-sm">
            {view.changes.map((c) => (
              <li key={`${c.kind}-${c.id}`} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{c.kind}</Badge>
                  <span className="font-medium">{c.title}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(c.at)}</span>
                  {c.approval && c.approval !== "not_required" && <Badge variant="secondary">client {human(c.approval)}</Badge>}
                  {!c.clientVisible && <Badge variant="secondary">internal</Badge>}
                </div>
                {c.targetUrl && <p className="mt-1 text-xs text-muted-foreground">{c.targetUrl}</p>}
                {c.before && <p className="mt-1 text-xs"><span className="text-muted-foreground">Before:</span> {c.before}</p>}
                {c.after && <p className="text-xs"><span className="text-muted-foreground">After:</span> {c.after}</p>}
                {c.reason && <p className="text-xs"><span className="text-muted-foreground">Why:</span> {c.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Measurement" description="Immutable baseline package; remeasurements on the same instrument. Non-comparable runs are labelled, never averaged in." actions={baseline && <RecordMeasurementDialog projectId={id} engagementId={e.id} slots={plannedSlots} />}>
        {baseline?.snapshot ? (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium">Baseline · {baseline.snapshot.provider} · {baseline.snapshot.models.join(", ")} · frozen {baseline.frozenAt ? formatDate(baseline.frozenAt) : ""}</p>
            <p className="mt-1 tabular-nums">{baseline.snapshot.subject.name}: {baseline.snapshot.subject.recommendedCount} of {baseline.snapshot.answerCount} valid answers · {baseline.snapshot.subject.distinctQuestions} of {baseline.snapshot.questionCount} questions</p>
            {baseline.snapshot.competitors.map((c) => (
              <p key={c.companyId} className="tabular-nums text-muted-foreground">{c.name}: {c.recommendedCount} of {baseline.snapshot!.answerCount} · {c.distinctQuestions} questions</p>
            ))}
            <p className="mt-1 text-xs text-muted-foreground">
              Aliases at freeze: {baseline.snapshot.subject.aliases.join(", ") || "none"} · run {baseline.snapshot.runId.slice(0, 8)} · scoring {baseline.snapshot.versions.scoringVersion} · resolver {baseline.snapshot.versions.resolverPolicy} · {baseline.snapshot.questions.reduce((s, q) => s + q.responseIds.length, 0)} raw answers referenced
            </p>
          </div>
        ) : (
          <EmptyState message="No frozen baseline. Freeze it from the pre-sale benchmark run (corrected evidence) before any work starts." />
        )}
        <ul className="mt-3 space-y-2 text-sm">
          {view.measurements.filter((m) => m.role !== "baseline").map((m) => (
            <li key={m.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{human(m.role)}</Badge>
                <Badge variant={m.status === "frozen" ? "secondary" : m.status === "planned" ? "outline" : "destructive"}>{human(m.status)}</Badge>
                <span className="text-xs text-muted-foreground">{m.scheduledFor ?? (m.frozenAt ? formatDate(m.frozenAt) : "")}</span>
                {m.comparability && <Badge variant={m.comparability.grade === "high" ? "outline" : "secondary"}>comparability {m.comparability.grade}</Badge>}
              </div>
              {m.comparison ? (
                <>
                  <p className="mt-1">{m.comparison.statement}</p>
                  <p className="text-xs text-muted-foreground">Gained: {m.comparison.gainedQuestions.length} · lost: {m.comparison.lostQuestions.length} · {m.comparison.competitors.map((c) => `${c.name} ${c.baseline}→${c.next}`).join(" · ")}</p>
                </>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">{m.statusDetail ?? m.reason}</p>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Weekly update (draft)" description="Composed from the record. Send it yourself; record that you did." actions={<UpdateSentDialog projectId={id} engagementId={e.id} draft={view.weeklyUpdate} />}>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">{view.weeklyUpdate}</pre>
      </Section>

      <Section title="Market exclusivity" description={`One retained client in ${e.marketName}. Sends to competing prospects here are refused at dispatch while the agreement is live.`} actions={outreachConflicts.length > 0 && (e.exclusivityStatus === "active" || e.exclusivityStatus === "reserved") && <ActionButton variant="destructive" label={`Pause outreach to ${outreachConflicts.length} prospect(s)`} onClick={pauseMarketOutreach.bind(null, id, { engagementId: e.id })} />}>
        {view.marketConflicts.length > 0 && (
          <p className="mb-2 text-sm text-destructive">Another live engagement overlaps this market: {view.marketConflicts.map((c) => `${c.marketName} (${c.relation})`).join(", ")}.</p>
        )}
        {outreachConflicts.length === 0 ? (
          <EmptyState message="No competing prospect in this market is being worked. New sends are refused by the dispatch gate regardless." />
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {outreachConflicts.map((c) => (
              <li key={c.prospectId} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <Link href={`/prospects/${c.prospectId}`} className="font-medium underline-offset-2 hover:underline">{c.businessName}</Link>
                <span className="text-xs text-muted-foreground">{human(c.stage)} · {c.scheduledDrafts} scheduled draft(s) · {c.activeSequences} active sequence(s)</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Commercial record" description="Scope, permissions, ledger. Contract and payment stay manual and truthful.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3 text-sm">
            <p className="text-xs text-muted-foreground">Scope</p>
            <p className="mt-1">{e.scopeSummary}</p>
            {e.scopeExclusions && <p className="mt-2 text-xs text-muted-foreground">{e.scopeExclusions}</p>}
            <p className="mt-2 text-xs text-muted-foreground">Payment terms: {e.paymentTerms || "not stated"} · {human(e.billingCadence)}</p>
          </div>
          <div className="rounded-md border p-3 text-sm">
            <p className="text-xs text-muted-foreground">Marketing permissions (default: no public use)</p>
            <div className="mt-2">
              {isAdmin ? (
                <PermissionToggles projectId={id} engagementId={e.id} values={{ caseStudy: e.caseStudyPermission, testimonial: e.testimonialPermission, logo: e.logoPermission, anonymizedData: e.anonymizedDataPermission }} />
              ) : (
                <p>case study {e.caseStudyPermission ? "yes" : "no"} · testimonial {e.testimonialPermission ? "yes" : "no"} · logo {e.logoPermission ? "yes" : "no"} · anonymized data {e.anonymizedDataPermission ? "yes" : "no"}</p>
              )}
            </div>
            {(view.derivedStage === "active" || view.derivedStage === "renewal_review") && (
              <div className="mt-3">
                <p className="text-xs text-muted-foreground">Renewal</p>
                <div className="mt-1"><RenewalStatusButtons projectId={id} engagementId={e.id} /></div>
              </div>
            )}
          </div>
        </div>
        {view.billing.events.length > 0 && (
          <ul className="mt-3 divide-y rounded-md border text-sm">
            {view.billing.events.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
                <span>{human(b.kind)}{b.externalInvoiceId ? ` · ${b.externalInvoiceId}` : ""}</span>
                <span className="tabular-nums text-xs text-muted-foreground">{usd(b.amountCents / 100)} · {b.dueDate ? `due ${b.dueDate} · ` : ""}{formatDate(b.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {e.closedAt && <p className="mt-3 text-xs text-muted-foreground">Closed {formatDate(e.closedAt)} — {e.closeReason}. Cold-prospecting cooldown until {e.cooldownUntil}.</p>}
      </Section>
    </PageShell>
  );
}
