import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState, PageHeader, PageShell, Section, Stat, StatGrid } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { OnboardingIntakeDialog } from "@/components/engagements/commercial-controls";
import {
  AcceptProtocolDialog,
  ActivateItemButton,
  ExternalImportDialog,
  ExternalQaDialog,
  FinalReviewButton,
  FreezeBaselineDialog,
  VoidBaselineDialog,
  ImportQuestionsDialog,
  MeetingNotesDialog,
  PlanActions,
  PlanItemDialog,
  PlanStartButtons,
  ProtocolDialog,
  ScheduleMeetingDialog,
  SubjectDecisionDialog,
  UpdateDraft,
  WeeklyDialog,
  WelcomeDialog,
} from "@/components/delivery/delivery-controls";
import { PrepareOnboardingDialog, ShareOnboardingButton } from "@/components/delivery/client-onboarding-controls";
import { onboardingDefaults, onboardingForEngagement } from "@/lib/engagements/client-onboarding";
import { changedFields, effective, marketDiffers, primaryFocusLabel, type PreparedPriorities } from "@/lib/engagements/client-onboarding-rules";
import { operatorReviewSummary } from "@/lib/engagements/client-question-review";
import { getProject } from "@/db/projects";
import { requireProjectStaffPage } from "@/lib/security/page-gates";
import { getCurrentUser } from "@/lib/auth";
import { deliveryState } from "@/lib/engagements/delivery";
import { PLAN_PHASES, PROTOCOL_DEFAULTS, WORK_STATE_LABELS, currentStep, rateView, type StepState } from "@/lib/engagements/delivery-rules";
import { baselineReadiness } from "@/lib/engagements/measurement";
import { onboardingPrefill } from "@/lib/engagements/onboarding-intake";
import { listContextItems } from "@/lib/engagements/service";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const STEP_VARIANT: Record<StepState, "default" | "secondary" | "outline" | "destructive"> = {
  done: "outline",
  current: "default",
  blocked: "destructive",
  upcoming: "secondary",
};
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/**
 * Client delivery (spec 154), internal operator surface: one guided
 * sequence from welcome to Day 90 over the engagement records. Every step is
 * derived from rows; every action is gated in the service, not here.
 */
export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  await requireProjectStaffPage((await params).id);
  const viewer = await getCurrentUser();
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();
  const crumbs = [{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${id}` }, { label: "Delivery" }];
  let state: Awaited<ReturnType<typeof deliveryState>>;
  try {
    state = await deliveryState(id);
  } catch {
    return (
      <PageShell>
        <PageHeader crumbs={crumbs} title="Client delivery" />
        <EmptyState message="The delivery records could not be loaded. Reload the page; if it persists, check the server log for this project." />
      </PageShell>
    );
  }
  if (!state) {
    return (
      <PageShell>
        <PageHeader crumbs={crumbs} title="Client delivery" description="The guided path from welcome to the Day-90 review." />
        <EmptyState message="No signed engagement for this client yet. Record the signed terms on the Engagement page first." action={<Link className="text-sm underline" href={`/projects/${id}/engagement`}>Open Engagement</Link>} />
      </PageShell>
    );
  }
  const s = state;
  const e = s.engagement;
  const [prefill, context] = await Promise.all([onboardingPrefill(e.id), listContextItems(e.id)]);
  const accepted = s.protocols.find((p) => p.status === "accepted") ?? null;
  const draft = s.protocols.find((p) => p.status === "draft") ?? null;
  const baseline = s.measurements.find((m) => m.role === "baseline" && m.status === "frozen") ?? null;
  const voided = s.measurements.filter((m) => m.role === "baseline" && m.status === "voided");
  const readyRun = s.candidateRuns.find((r) => r.matchesProtocol && (r.status === "completed" || r.status === "partial"));
  const readiness = !baseline && readyRun && accepted ? await baselineReadiness(readyRun.id, accepted.provider) : null;
  const step = currentStep(s.journey);
  const variants = context.filter((c) => typeof c.value.nameVariant === "string").map((c) => c.value.nameVariant as string);
  const protocolInitial = draft ?? accepted;
  const drafts = s.updates.filter((u) => u.status === "draft");
  const sent = s.updates.filter((u) => u.status === "sent");
  const baseRate = baseline?.snapshot ? rateView(baseline.snapshot) : null;
  const planItems = s.roadmap?.items ?? [];
  const [onboarding, onboardingInitial, portalReview] = await Promise.all([
    onboardingForEngagement(e.id),
    onboardingDefaults(e.id),
    s.questionSet ? operatorReviewSummary(s.questionSet, e.id) : Promise.resolve(null),
  ]);
  const onboardingChanged = onboarding?.clientPriorities ? changedFields(onboarding.preparedPriorities as Record<string, unknown>, onboarding.clientPriorities as Record<string, unknown>) : [];
  const onboardingShown = onboarding ? { priorities: effective<PreparedPriorities>(onboarding.preparedPriorities, onboarding.clientPriorities), contacts: effective(onboarding.preparedContacts, onboarding.clientContacts) } : null;

  return (
    <PageShell>
      <PageHeader
        crumbs={crumbs}
        title="Client delivery"
        description={`${e.clientLegalName || project.name} · ${e.marketName} · ${e.startsOn} to ${e.endsOn}`}
        badge={<Badge variant="secondary">{e.stage.replace(/_/g, " ")}</Badge>}
        actions={<Link className="text-sm underline-offset-2 hover:underline" href={`/portal/${id}`}>Preview client portal</Link>}
      />

      {step && (
        <div className="rounded-md border bg-muted/40 p-4" role="status">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Next step</p>
          <p className="mt-1 text-sm font-medium">{step.operatorLabel}</p>
          <p className="mt-1 text-sm">{step.operatorAction}</p>
        </div>
      )}

      <Section title="Journey" description="Derived from records — nothing here is ticked by hand.">
        <ol className="grid gap-2 sm:grid-cols-2">
          {s.journey.map((j, n) => (
            <li key={j.key} className="flex items-start gap-3 rounded-md border p-3">
              <span className="text-sm tabular-nums text-muted-foreground">{n + 1}.</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">{j.operatorLabel}</p>
                  <Badge variant={STEP_VARIANT[j.state]}>{j.state}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{j.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="1 · Welcome and portal access" description="One message: what we are doing, who to contact, what happens next, and the portal link.">
        <p className="text-sm">
          {s.portalGrants} portal login(s).{" "}
          {s.portalGrants === 0 && <>Invite the primary contact from <Link className="underline" href={`/projects/${id}/settings`}>Settings</Link> (admin; needs live sign-in).</>}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {e.stage !== "signed" && !sent.some((u) => u.kind === "welcome") && <WelcomeDialog projectId={id} engagementId={e.id} />}
          {sent.filter((u) => u.kind === "welcome").map((u) => <Badge key={u.id} variant="outline">Welcome sent {u.sentAt ? formatDate(u.sentAt) : ""}</Badge>)}
        </div>
        <div className="mt-3 space-y-3">
          {drafts.filter((u) => u.kind === "welcome").map((u) => <UpdateDraft key={u.id} projectId={id} updateId={u.id} kind={u.kind} text={u.body.text} />)}
        </div>
      </Section>

      <Section
        title="Client onboarding"
        description="What the client confirms on first sign-in: four priorities and their contacts. Prepared from records; the client confirms or corrects."
        actions={
          <div className="flex flex-wrap gap-2">
            {(!onboarding || (onboarding.status !== "completed" && !onboarding.prioritiesConfirmedAt && !onboarding.clientPriorities)) && onboardingInitial && (
              <PrepareOnboardingDialog projectId={id} engagementId={e.id} initial={onboarding ? { priorities: onboarding.preparedPriorities, contacts: onboarding.preparedContacts } : onboardingInitial} />
            )}
            {onboarding?.status === "draft" && <ShareOnboardingButton projectId={id} engagementId={e.id} />}
          </div>
        }
      >
        {!onboarding || !onboardingShown ? (
          <EmptyState message="Not prepared yet. Prepare it from the records, then share it once the commercial gate has passed — the client sees it on their first sign-in." />
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              <Badge variant={onboarding.status === "completed" ? "outline" : onboarding.status === "ready" ? "default" : "secondary"}>
                {onboarding.status === "completed" ? `Confirmed by the client ${onboarding.completedAt ? formatDate(onboarding.completedAt) : ""}` : onboarding.status === "ready" ? (onboarding.prioritiesConfirmedAt ? "Client confirmed priorities; contacts pending" : "Shared — waiting for the client") : "Draft — not visible to the client"}
              </Badge>
            </p>
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[12rem_1fr]">
              <dt className="text-muted-foreground">Primary focus</dt><dd>{primaryFocusLabel(onboardingShown.priorities.primaryFocus) || "—"}{onboardingChanged.includes("primaryFocus") && <Badge variant="secondary" className="ml-2">changed by client</Badge>}</dd>
              <dt className="text-muted-foreground">Minimum value</dt><dd>{onboardingShown.priorities.minPropertyValueUsd ? `$${onboardingShown.priorities.minPropertyValueUsd.toLocaleString("en-US")}` : "No minimum"}{onboardingChanged.includes("minPropertyValueUsd") && <Badge variant="secondary" className="ml-2">changed by client</Badge>}</dd>
              <dt className="text-muted-foreground">Additional opportunity</dt><dd>{onboardingShown.priorities.additionalOpportunity || "None"}{onboardingChanged.includes("additionalOpportunity") && <Badge variant="secondary" className="ml-2">changed by client</Badge>}</dd>
              <dt className="text-muted-foreground">Market</dt>
              <dd>
                {onboardingShown.priorities.market || "—"}
                {onboardingChanged.includes("market") && <Badge variant="secondary" className="ml-2">changed by client</Badge>}
                {onboardingShown.priorities.market && marketDiffers(onboardingShown.priorities.market, e.marketName) && <Badge variant="destructive" className="ml-2">differs from engagement market ({e.marketName}) — review; not applied</Badge>}
              </dd>
              <dt className="text-muted-foreground">Contacts</dt>
              <dd>{onboardingShown.contacts.primaryName || "— (client asked)"} {onboardingShown.contacts.primaryEmail ? `<${onboardingShown.contacts.primaryEmail}>` : "· email: client asked"} · approver: {onboardingShown.contacts.approverIsPrimary ? "main contact" : onboardingShown.contacts.approverName || "client asked"}</dd>
            </dl>
          </div>
        )}
        {portalReview && s.questionSet && portalReview.reviewed > 0 && (
          <div className="mt-4 space-y-1 text-sm">
            <p className="font-medium">Portal question review · v{s.questionSet.version}</p>
            <p className="tabular-nums text-muted-foreground">{portalReview.reviewed} of {s.questionSet.questions.length} reviewed · {portalReview.counts.approved} approved · {portalReview.counts.carried} carried (unchanged wording) · {portalReview.counts.edit_requested} edit requested · {portalReview.counts.removed} removal</p>
            {portalReview.requests.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5">
                {portalReview.requests.map((r) => <li key={r.text}>{r.decision === "removed" ? "Remove" : "Edit"}: {r.text}{r.comment ? ` — “${r.comment}”` : ""}</li>)}
              </ul>
            )}
          </div>
        )}
      </Section>

      <Section title="2 · Business details" description="Prefilled from the prospect record; the client confirms instead of retyping." actions={prefill ? <OnboardingIntakeDialog prefill={prefill} /> : undefined}>
        <StatGrid columns={4}>
          <Stat label="Minimum value" value={s.minPropertyValueUsd ? `$${s.minPropertyValueUsd.toLocaleString("en-US")}` : "—"} hint="client-confirmed floor" />
          <Stat label="Neighborhoods" value={context.filter((c) => c.value.type === "neighborhood").length} />
          <Stat label="Name variants" value={variants.length} hint="verify before the baseline" />
          <Stat label="Prefilled fields" value={prefill?.prefilled.length ?? 0} hint="from verified records" />
        </StatGrid>
      </Section>

      <Section title="3 · Questions" description="Import the client-reviewed sheet, then record the client's approval of that exact version." actions={<ImportQuestionsDialog projectId={id} engagementId={e.id} floorUsd={s.minPropertyValueUsd} />}>
        {s.questionSet ? (
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium">{s.questionSet.setName}</span> v{s.questionSet.version} · {s.questionSet.questions.length} questions · frozen {formatDate(s.questionSet.frozenAt)}{" "}
              <Badge variant={s.questionSet.decision?.decision === "approved" ? "outline" : "secondary"}>{s.questionSet.decision ? s.questionSet.decision.decision.replace(/_/g, " ") : "awaiting client"}</Badge>
            </p>
            <p className="text-muted-foreground">
              {Object.entries(s.questionSet.questions.reduce<Record<string, number>>((acc, q) => ({ ...acc, [q.priceTier ?? "Unspecified"]: (acc[q.priceTier ?? "Unspecified"] ?? 0) + 1 }), {})).map(([k, v]) => `${k}: ${v}`).join(" · ")}
            </p>
            <SubjectDecisionDialog projectId={id} engagementId={e.id} subjectKind="question_set" subjectRef={s.questionSet.versionId} trigger="Record client decision" />
          </div>
        ) : (
          <EmptyState message="No question set yet. Export the client's review sheet to CSV and import it." />
        )}
      </Section>

      <Section title="4 · Measurement protocol" description="What is measured, how, and what success means — accepted by the client before the baseline.">
        {s.questionSet || protocolInitial ? (
          <div className="space-y-3 text-sm">
            {accepted && (
              <p>
                <Badge variant="outline">accepted</Badge> v{accepted.version} by {accepted.acceptedByName} via {accepted.acceptedChannel} on {accepted.acceptedAt ? formatDate(accepted.acceptedAt) : ""} · {accepted.provider} / {accepted.model} × {accepted.repetitions}
              </p>
            )}
            {draft && <p><Badge variant="secondary">draft</Badge> v{draft.version} · success criteria: {draft.successCriteria || "not written yet"}</p>}
            <div className="flex flex-wrap gap-2">
              {!baseline && (
                <ProtocolDialog
                  projectId={id}
                  engagementId={e.id}
                  trigger={draft ? "Edit draft" : accepted ? "Draft a new version" : "Draft protocol"}
                  initial={{
                    promptSetVersionId: protocolInitial?.promptSetVersionId ?? s.questionSet!.versionId,
                    provider: protocolInitial?.provider ?? "openai",
                    model: protocolInitial?.model ?? "",
                    geographicContext: protocolInitial?.geographicContext ?? "",
                    repetitions: protocolInitial?.repetitions ?? 4,
                    baselineWindow: protocolInitial?.baselineWindow ?? "",
                    finalWindow: protocolInitial?.finalWindow ?? "",
                    recommendationRubric: protocolInitial?.recommendationRubric ?? PROTOCOL_DEFAULTS.recommendationRubric,
                    comparisonRules: protocolInitial?.comparisonRules ?? PROTOCOL_DEFAULTS.comparisonRules,
                    caveats: protocolInitial?.caveats ?? PROTOCOL_DEFAULTS.caveats,
                    adjudication: protocolInitial?.adjudication ?? PROTOCOL_DEFAULTS.adjudication,
                    successCriteria: protocolInitial?.successCriteria ?? "",
                    entityAliases: protocolInitial?.entityAliases ?? [e.clientLegalName, ...variants].filter(Boolean),
                    externalSources: protocolInitial?.externalSources ?? PROTOCOL_DEFAULTS.externalSources,
                  }}
                />
              )}
              {draft && !baseline && <AcceptProtocolDialog projectId={id} protocolId={draft.id} />}
            </div>
            {baseline && <p className="text-xs text-muted-foreground">The baseline is locked, so the accepted protocol is fixed for this term.</p>}
          </div>
        ) : (
          <EmptyState message="Import the questions first; the protocol cites one frozen question version." />
        )}
      </Section>

      <Section title="5 · Baseline" description="Locked once, on the protocol's questions, after parsing and human review." actions={baseline && viewer.role === "admin" ? <VoidBaselineDialog projectId={id} engagementId={e.id} measurementId={baseline.id} /> : undefined}>
        {voided.map((m) => (
          <p key={m.id} className="mb-2 text-sm text-muted-foreground">
            Voided baseline (locked {m.frozenAt ? formatDate(m.frozenAt) : "—"}, voided {m.voidedAt ? formatDate(m.voidedAt) : "—"}): {m.voidReason}
          </p>
        ))}
        {baseline && baseRate ? (
          <StatGrid columns={4}>
            <Stat label="Recommended" value={`${baseRate.recommended} of ${baseRate.answers}`} hint={pct(baseRate.rate)} />
            <Stat label="Questions with a recommendation" value={`${baseRate.distinctQuestions} of ${baseRate.questions}`} />
            <Stat label="Instrument" value={baseRate.provider} hint={baseRate.models.join(", ")} />
            <Stat label="Locked" value={baseline.frozenAt ? formatDate(baseline.frozenAt) : "—"} hint={`scoring ${baseRate.scoringVersion}`} />
          </StatGrid>
        ) : accepted ? (
          <div className="space-y-2 text-sm">
            {readiness ? (
              <ul className="space-y-1">
                <li>Run {readyRun!.label || readyRun!.id.slice(0, 8)}: {readiness.expectedCells - readiness.outstandingCells} of {readiness.expectedCells} cells answered, {readiness.unparsed} unparsed, {readiness.pendingReview} awaiting review, {readiness.heuristicRows} keyword-fallback, {readiness.reused} copied captures.</li>
                {readiness.blockers.map((b) => <li key={b} className="text-destructive">Blocks: {b}</li>)}
                {readiness.warnings.map((w) => <li key={w} className="text-muted-foreground">Warning: {w}</li>)}
              </ul>
            ) : (
              <p>No finished run on the protocol&apos;s question set yet. Start it from <Link className="underline" href={`/projects/${id}/runs`}>Runs</Link> with the protocol&apos;s provider, model and repetitions.</p>
            )}
            <FreezeBaselineDialog projectId={id} engagementId={e.id} runs={s.candidateRuns} />
          </div>
        ) : (
          <EmptyState message="Pending: the baseline can only be locked under an accepted protocol." />
        )}
      </Section>

      <Section title="6 · 90-day plan" description="Drafted from observations, edited by you, published to the client." actions={s.roadmap ? <PlanActions projectId={id} planId={s.roadmap.planId} status={s.roadmap.status} /> : undefined}>
        {!s.roadmap ? (
          <EmptyState message={baseline ? "No plan yet. Draft it from the baseline gaps, or start blank." : "No plan yet. You can start blank now; drafting from observations needs the locked baseline."} action={<PlanStartButtons projectId={id} baselineLocked={Boolean(baseline)} />} />
        ) : (
          <div className="space-y-4">
            <p className="text-sm">{s.roadmap.title} · <Badge variant={s.roadmap.status === "draft" ? "secondary" : "outline"}>{s.roadmap.status === "draft" ? "draft — client cannot see it" : "published"}</Badge></p>
            {PLAN_PHASES.map((ph) => {
              const items = planItems.filter((i) => i.phase === ph.key);
              return (
                <div key={ph.key}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{ph.label} · {ph.title}</p>
                    {ph.key === "foundation" && <PlanItemDialog projectId={id} planId={s.roadmap!.planId} others={planItems.map((i) => ({ id: i.id, title: i.title }))} />}
                  </div>
                  {items.length === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">No items in this phase.</p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {items.map((i) => (
                        <li key={i.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3 text-sm">
                          <div className="min-w-0">
                            <p className="font-medium">{i.title}</p>
                            <p className="text-xs text-muted-foreground">{WORK_STATE_LABELS[i.state]} · {i.owner} · due {i.dueOn ?? "—"}{i.task && !i.task.clientVisible ? " · task not client-visible" : ""}</p>
                          </div>
                          <div className="flex gap-2">
                            <PlanItemDialog projectId={id} planId={s.roadmap!.planId} item={i} others={planItems.map((x) => ({ id: x.id, title: x.title }))} />
                            {!i.taskId && i.status === "planned" && s.roadmap!.status !== "draft" && <ActivateItemButton projectId={id} planItemId={i.id} />}
                            {i.taskId && <Link className="text-xs underline" href={`/projects/${id}/tasks`}>Task</Link>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="7 · Weekly updates and Day-90 review" description="Built from records. You review, send it yourself, then mark it sent." actions={<div className="flex flex-wrap gap-2">{e.stage !== "signed" && <WeeklyDialog projectId={id} engagementId={e.id} />}{baseline && <FinalReviewButton projectId={id} engagementId={e.id} />}</div>}>
        <div className="space-y-3">
          {drafts.filter((u) => u.kind !== "welcome").map((u) => <UpdateDraft key={u.id} projectId={id} updateId={u.id} kind={u.kind} text={u.body.text} />)}
          {sent.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {sent.map((u) => <li key={u.id}>{u.kind.replace(/_/g, " ")} · {u.periodEnd ?? ""} · sent {u.sentAt ? formatDate(u.sentAt) : ""} via {u.channel}</li>)}
            </ul>
          )}
        </div>
      </Section>

      <Section title="8 · Check-ins" description={`Every two weeks. Next due ${s.nextCheckin.date}${s.nextCheckin.scheduled ? " (scheduled)" : " (not scheduled)"}.`} actions={<ScheduleMeetingDialog projectId={id} engagementId={e.id} suggested={s.nextCheckin.date} />}>
        {s.meetings.length === 0 ? (
          <EmptyState message="No check-ins yet. Schedule the kickoff, then one every two weeks." />
        ) : (
          <ul className="space-y-2">
            {s.meetings.map((mt) => (
              <li key={mt.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <span>{mt.kind.replace(/_/g, " ")} · {formatDate(mt.scheduledFor)} · <Badge variant={mt.status === "held" ? "outline" : "secondary"}>{mt.status}</Badge> {mt.actionItems.length > 0 ? `· ${mt.actionItems.length} action item(s)` : ""}</span>
                {mt.status !== "cancelled" && <MeetingNotesDialog projectId={id} meeting={{ id: mt.id, status: mt.status, notes: mt.notes, actionItems: mt.actionItems, clientVisible: mt.clientVisible }} />}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="9 · External measurements" description="Manual imports from third-party tools. Separate from our numbers; hidden from the client until verified." actions={<ExternalImportDialog projectId={id} engagementId={e.id} />}>
        {s.external.length === 0 ? (
          <EmptyState message="None. Delivery does not depend on an external tool." />
        ) : (
          <ul className="space-y-2">
            {s.external.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm">
                <span>{x.providerLabel} · {x.capturedFrom} to {x.capturedTo} · recommendation vs mention: {x.distinguishesRecommendation} · <Badge variant={x.qaStatus === "verified" ? "outline" : x.qaStatus === "rejected" ? "destructive" : "secondary"}>{x.qaStatus}</Badge> {x.clientVisible ? "· visible to client" : ""} · sha256 {x.rawSha256.slice(0, 12)}</span>
                <ExternalQaDialog projectId={id} id={x.id} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="10 · Wrap-up" description="Close or renew on the Engagement page after this list is done.">
        <ul className="space-y-1 text-sm">
          {s.offboarding.map((o) => (
            <li key={o.key} className="flex items-start gap-2">
              <Badge variant={o.done ? "outline" : "secondary"}>{o.done ? "done" : "open"}</Badge>
              <span>{o.label} <span className="text-muted-foreground">— {o.detail}</span></span>
            </li>
          ))}
        </ul>
      </Section>
    </PageShell>
  );
}
