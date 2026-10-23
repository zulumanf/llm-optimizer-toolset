/**
 * Client portal — engagement delivery reads (spec 154). Read-only. Every
 * function re-asserts project access (layouts are not an authorization
 * boundary) and passes only client-safe fields: no fees, invoices, gate
 * reasons, operator notes, costs, user ids, drafts, unverified external
 * results, or tasks the agency has not made client-visible.
 *
 * Numbers come ONLY from frozen engagement snapshots (audit P1-06): no
 * snapshot → "pending", never 0%.
 */
import { sql } from "@/db/client";
import { assertProjectAccess, isClient, isClientApprover, ProjectAccessError, type CurrentUser } from "@/lib/auth";
import { engagementForProject, listContextItems, listMeasurements, type MeasurementRow } from "@/lib/engagements/service";
import {
  deliveryState,
  listExternalMeasurements,
  listMeetings,
  listProtocols,
  listSubjectDecisions,
  listUpdates,
  planForProject,
  proposedQuestionSet,
  type ExternalMeasurementRow,
  type MeetingRow,
  type ProposedQuestionSet,
  type UpdateRow,
} from "@/lib/engagements/delivery";
import {
  MEASUREMENT_CAVEATS,
  clientProviderLabel,
  deliveryJourney,
  differenceInterval,
  engagementDay,
  latestComparable,
  phaseProgress,
  phaseWindows,
  questionChanges,
  rateView,
  segmentBreakdown,
  type Interval,
  type JourneyStepKey,
  type PhaseProgress,
  type PhaseWindow,
  type RateView,
  type SegmentRow,
  type StepState,
  type WorkState,
} from "@/lib/engagements/delivery-rules";
import { todayIso } from "@/lib/engagements/rules";
import { portalOnboarding } from "@/lib/engagements/client-onboarding";
import { portalQuestionReview } from "@/lib/engagements/client-question-review";
import { FOCUS_BY_STEP, focusFromWork, questionReviewTodo } from "@/lib/portal/client-copy";

/** Absolute link for invitations. Deliberately `/portal`, never a project id:
 * the portal routes a client to their only grant, so an email link can never
 * point at — or reveal — another client. Null when APP_URL is unset. */
export function portalLoginUrl(appUrl: string | undefined = process.env.APP_URL): string | null {
  if (!appUrl) return null;
  try {
    return new URL("/portal", appUrl).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- overview

export interface ClientStep {
  key: JourneyStepKey;
  label: string;
  state: StepState;
}

export interface ClientTodo {
  key: string;
  label: string;
  href: string;
  /** Only the client's approver can do this (viewers see it as status). */
  approverOnly: boolean;
}

export interface ClientResultsSummary {
  status: "pending" | "measured";
  baseline: RateView | null;
  latest: (RateView & { comparabilityGrade: string; isBaseline: boolean }) | null;
  change: { delta: number; interval: Interval | null } | null;
  nextMeasurementOn: string | null;
}

export interface ClientOverview {
  clientName: string;
  marketName: string;
  startsOn: string;
  endsOn: string;
  day: number | null;
  stageLabel: string;
  scopeSummary: string;
  steps: ClientStep[];
  currentStep: ClientStep | null;
  todos: ClientTodo[];
  /** A read-only client account (spec 155 R2): approver-only items are status, not actions. */
  viewer: boolean;
  results: ClientResultsSummary;
  latestUpdate: { id: string; kind: string; sentAt: Date; periodEnd: string | null; sections: { title: string; lines: string[] }[] } | null;
  plan: { published: boolean; phases: (PhaseProgress & PhaseWindow)[]; completed: number; total: number };
  approvalsWaiting: { id: string; title: string }[];
  nextMeeting: { at: Date; kind: string } | null;
  nextCheckinDue: string;
  /** Spec 155 — the four Overview sections. */
  focus: { work: string[]; sentence: string };
  progress: { published: boolean; completed: number; ongoing: number; upcoming: number; total: number };
  latest:
    | { kind: "update"; at: Date; label: string; lines: string[] }
    | { kind: "measurement"; at: Date; rate: RateView; isBaseline: boolean }
    | null;
  baselineLocked: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  signed: "Getting started",
  onboarding: "Onboarding",
  active: "In delivery",
  renewal_review: "Final review",
  renewed: "Renewed",
  completed: "Completed",
  churned: "Ended",
};

function updateLabel(u: UpdateRow): string {
  if (u.kind === "welcome") return "Welcome message";
  if (u.kind === "final_review") return "Day-90 review";
  return u.periodEnd ? `Weekly update · week ending ${new Date(`${u.periodEnd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Weekly update";
}

function resultsSummary(measurements: MeasurementRow[]): ClientResultsSummary {
  const { baseline, latest } = latestComparable(measurements);
  const nextPlanned = measurements
    .filter((m) => m.status === "planned" && m.scheduledFor)
    .sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!))[0];
  const b = baseline?.snapshot ? rateView(baseline.snapshot) : null;
  const l = latest?.snapshot ? rateView(latest.snapshot) : null;
  if (!b) return { status: "pending", baseline: null, latest: null, change: null, nextMeasurementOn: nextPlanned?.scheduledFor ?? null };
  const isBaseline = latest?.id === baseline?.id;
  return {
    status: "measured",
    baseline: b,
    latest: l ? { ...l, comparabilityGrade: isBaseline ? "baseline" : (latest?.comparability?.grade ?? "not_comparable"), isBaseline } : null,
    change: l && !isBaseline ? { delta: l.rate - b.rate, interval: differenceInterval(b.recommended, b.answers, l.recommended, l.answers) } : null,
    nextMeasurementOn: nextPlanned?.scheduledFor ?? null,
  };
}

export async function portalDeliveryOverview(user: CurrentUser, projectId: string, today = todayIso()): Promise<ClientOverview | null> {
  await assertProjectAccess(user, projectId);
  const state = await deliveryState(projectId, today);
  if (!state) return null;
  const e = state.engagement;
  // Someone reading the portal has portal access by definition; the client's
  // view of "welcome" is done once the welcome was sent.
  const journey = deliveryJourney({ ...state.journeyInput, portalGrants: Math.max(1, state.journeyInput.portalGrants) });
  const steps: ClientStep[] = journey.map((s) => ({ key: s.key, label: s.clientLabel, state: s.state }));
  const current = steps.find((s) => s.state === "current" || s.state === "blocked") ?? null;
  const approvalTasks = await sql`
    select id, title from tasks
    where project_id = ${projectId} and client_visible and client_approval = 'required' and status not in ('done', 'rejected')
    order by updated_at desc
  `;
  const [accessOpen] = await sql`
    select count(*)::int as n from engagement_context_items where engagement_id = ${e.id} and kind = 'access' and access_status = 'requested'
  `;
  const base = `/portal/${projectId}`;
  const [onboarding, review] = await Promise.all([portalOnboarding(user, projectId), portalQuestionReview(user, projectId)]);
  const todos: ClientTodo[] = [];
  // Only what genuinely needs the client, each pointing at where they act.
  // A question review the client already sent is on us, not on them.
  if (onboarding?.status === "ready") todos.push({ key: "details", label: "Confirm your business details (about 2 minutes)", href: `${base}/welcome`, approverOnly: true });
  if (review && !review.locked && !review.submitted) todos.push({ key: "questions", label: questionReviewTodo(review.remaining, review.total), href: `${base}/approvals/questions`, approverOnly: true });
  // Spec 155 R3: the binding step, once the review is complete and the plan is ready.
  if (review?.plan?.ready) todos.push({ key: "plan", label: "Approve your measurement plan", href: `${base}/approvals/measurement`, approverOnly: true });
  for (const s of journey) {
    if (!((s.state === "current" || s.state === "blocked") && s.clientAction)) continue;
    // Questions and the plan are handled above, from the review itself.
    if (s.key === "questions" || s.key === "protocol") continue;
    if (s.key === "details") {
      if (!onboarding) todos.push({ key: s.key, label: s.clientAction, href: `${base}/approvals#details`, approverOnly: false });
    } else {
      todos.push({ key: s.key, label: s.clientAction, href: `${base}/approvals#${s.key}`, approverOnly: false });
    }
  }
  if (approvalTasks.length > 0) todos.push({ key: "approvals", label: `${approvalTasks.length} proposed change(s) need your approval.`, href: `${base}/approvals#changes`, approverOnly: false });
  if (Number(accessOpen?.n ?? 0) > 0) todos.push({ key: "access", label: "Give us delegated editor access where we asked (never a password).", href: `${base}/approvals#details`, approverOnly: false });
  const sent = state.updates.filter((u) => u.status === "sent" && u.kind !== "welcome");
  const latest = sent[0] ?? state.updates.find((u) => u.status === "sent") ?? null;
  const published = Boolean(state.roadmap && ["approved", "active", "completed"].includes(state.roadmap.status));
  const items = published ? state.roadmap!.items : [];
  const progress = phaseProgress(items.map((i) => ({ phase: i.phase, state: i.state })));
  const windows = phaseWindows(e.startsOn);
  const nextMeeting = state.meetings.filter((m) => m.status === "planned" && m.clientVisible && m.scheduledFor.toISOString().slice(0, 10) >= today).sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0];
  const working = await sql`
    select title from tasks
    where project_id = ${projectId} and client_visible and status = 'in_progress'
    order by updated_at desc limit 2
  `;
  const results = resultsSummary(state.measurements);
  const latestMeasurement = (() => {
    const { latest: m } = latestComparable(state.measurements);
    return m?.snapshot && m.frozenAt && results.latest ? { kind: "measurement" as const, at: m.frozenAt, rate: results.latest, isBaseline: results.latest.isBaseline } : null;
  })();
  const sentUpdate = latest ? { kind: "update" as const, at: latest.sentAt!, label: updateLabel(latest), lines: latest.body.sections.filter((s) => s.lines.length > 0 && s.title !== "Blocked on our side").slice(0, 2).map((s) => `${s.title}: ${s.lines[0]}`) } : null;
  const latestEntry = [sentUpdate, latestMeasurement].filter((x): x is NonNullable<typeof x> => x !== null).sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  const live = items.filter((i) => i.state !== "dropped");
  return {
    focus: {
      work: focusFromWork(working.map((w) => w.title as string)),
      sentence: FOCUS_BY_STEP[current?.key ?? "delivery"],
    },
    progress: {
      published,
      completed: live.filter((i) => i.state === "completed").length,
      ongoing: live.filter((i) => i.state === "in_progress" || i.state === "blocked").length,
      upcoming: live.filter((i) => i.state === "proposed").length,
      total: live.length,
    },
    latest: latestEntry,
    baselineLocked: results.status === "measured",
    clientName: e.clientLegalName || e.primaryContactName || e.marketName,
    marketName: e.marketName,
    startsOn: e.startsOn,
    endsOn: e.endsOn,
    day: engagementDay(e.startsOn, today),
    stageLabel: STAGE_LABELS[e.stage] ?? e.stage,
    scopeSummary: e.scopeSummary,
    steps,
    currentStep: current,
    todos,
    viewer: isClient(user) && !isClientApprover(user),
    results,
    latestUpdate: latest ? { id: latest.id, kind: latest.kind, sentAt: latest.sentAt!, periodEnd: latest.periodEnd, sections: latest.body.sections } : null,
    plan: {
      published,
      phases: progress.map((p) => ({ ...p, ...windows.find((w) => w.key === p.key)! })),
      completed: items.filter((i) => i.state === "completed").length,
      total: items.filter((i) => i.state !== "dropped").length,
    },
    approvalsWaiting: approvalTasks.map((t) => ({ id: t.id as string, title: t.title as string })),
    nextMeeting: nextMeeting ? { at: nextMeeting.scheduledFor, kind: nextMeeting.kind } : null,
    nextCheckinDue: state.nextCheckin.date,
  };
}

// ----------------------------------------------------------------- results

export interface ClientQuestionRow {
  promptId: string;
  text: string;
  priceTier: string | null;
  neighborhood: string | null;
  answers: number;
  recommended: number;
  competitorRecommended: { name: string; count: number }[];
  responseIds: string[];
  change: "gained" | "lost" | "steady" | null;
}

export interface ClientResults {
  summary: ClientResultsSummary;
  caveats: readonly string[];
  protocol: { version: number; providerLabel: string; model: string; geographicContext: string; repetitions: number; recommendationRubric: string; comparisonRules: string; successCriteria: string; acceptedAt: Date | null } | null;
  comparability: { grade: string; reasons: string[] } | null;
  competitors: { name: string; baseline: number; latest: number | null }[];
  segments: { priceTier: SegmentRow[]; neighborhood: SegmentRow[] } | null;
  baselineSegments: { priceTier: SegmentRow[]; neighborhood: SegmentRow[] } | null;
  questions: ClientQuestionRow[];
  external: Omit<ExternalMeasurementRow, "qaNote" | "clientVisible" | "qaStatus">[];
  nonComparable: { at: Date; role: string; reasons: string[] }[];
}

export async function portalResults(user: CurrentUser, projectId: string): Promise<ClientResults | null> {
  await assertProjectAccess(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const measurements = await listMeasurements(e.id);
  const summary = resultsSummary(measurements);
  const { baseline, latest } = latestComparable(measurements);
  const protocol = (await listProtocols(e.id)).find((p) => p.status === "accepted") ?? null;
  const external = (await listExternalMeasurements(e.id, { clientSafe: true })).map(({ qaNote: _n, clientVisible: _v, qaStatus: _s, ...rest }) => {
    void _n;
    void _v;
    void _s;
    return rest;
  });
  const nonComparable = measurements
    .filter((m) => m.status === "non_comparable" && m.frozenAt)
    .map((m) => ({ at: m.frozenAt!, role: m.role, reasons: m.comparability?.reasons ?? [] }));
  const protocolView = protocol
    ? { version: protocol.version, providerLabel: clientProviderLabel(protocol.provider), model: protocol.model, geographicContext: protocol.geographicContext, repetitions: protocol.repetitions, recommendationRubric: protocol.recommendationRubric, comparisonRules: protocol.comparisonRules, successCriteria: protocol.successCriteria, acceptedAt: protocol.acceptedAt }
    : null;
  if (!baseline?.snapshot) {
    return { summary, caveats: MEASUREMENT_CAVEATS, protocol: protocolView, comparability: null, competitors: [], segments: null, baselineSegments: null, questions: [], external, nonComparable };
  }
  const b = baseline.snapshot;
  const l = latest?.snapshot ?? b;
  const isBaseline = latest?.id === baseline.id;
  const changes = isBaseline ? null : questionChanges(b, l);
  const changeOf = (id: string): ClientQuestionRow["change"] => (!changes ? null : changes.gained.includes(id) ? "gained" : changes.lost.includes(id) ? "lost" : "steady");
  const names = new Map(l.competitors.map((c) => [c.companyId, c.name]));
  return {
    summary,
    caveats: MEASUREMENT_CAVEATS,
    protocol: protocolView,
    comparability: isBaseline ? null : { grade: latest?.comparability?.grade ?? "not_comparable", reasons: latest?.comparability?.reasons ?? [] },
    competitors: b.competitors.map((c) => ({ name: c.name, baseline: c.recommendedCount, latest: isBaseline ? null : (l.competitors.find((x) => x.companyId === c.companyId)?.recommendedCount ?? 0) })),
    segments: { priceTier: segmentBreakdown(l, "priceTier"), neighborhood: segmentBreakdown(l, "neighborhood") },
    baselineSegments: isBaseline ? null : { priceTier: segmentBreakdown(b, "priceTier"), neighborhood: segmentBreakdown(b, "neighborhood") },
    questions: l.questions.map((q) => ({
      promptId: q.promptId,
      text: q.text,
      priceTier: q.segment?.priceTier ?? null,
      neighborhood: q.segment?.neighborhood ?? null,
      answers: q.answerCount,
      recommended: q.subjectRecommended,
      competitorRecommended: Object.entries(q.competitorRecommended).filter(([, n]) => n > 0).map(([id, n]) => ({ name: names.get(id) ?? "Competitor", count: n })),
      responseIds: q.responseIds,
      change: changeOf(q.promptId),
    })),
    external,
    nonComparable,
  };
}

// ------------------------------------------------------- verbatim answers

export interface ClientAnswer {
  id: string;
  question: string;
  answer: string | null;
  providerLabel: string;
  model: string;
  capturedAt: Date;
  repetition: number;
  citations: { url: string; domain: string }[];
}

/** May this client read this stored answer? Only when it is evidence behind
 * one of their frozen snapshots, or it was captured in their own project. */
async function answerAuthorized(projectId: string, responseId: string): Promise<boolean> {
  const [hit] = await sql`
    select 1 as ok from engagement_measurements m
    where m.project_id = ${projectId} and m.status in ('frozen', 'non_comparable') and m.snapshot is not null
      and exists (
        select 1 from jsonb_array_elements(m.snapshot -> 'questions') q, jsonb_array_elements_text(q -> 'responseIds') rid
        where rid = ${responseId}
      )
    union all
    select 1 from responses r join runs x on x.id = r.run_id where r.id = ${responseId} and x.project_id = ${projectId}
    limit 1
  `;
  return Boolean(hit);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function portalAnswer(user: CurrentUser, projectId: string, responseId: string): Promise<ClientAnswer> {
  await assertProjectAccess(user, projectId);
  if (!UUID_RE.test(responseId) || !(await answerAuthorized(projectId, responseId))) throw new ProjectAccessError();
  const [r] = await sql`
    select id, prompt_text, response_text, provider, model, requested_at, repetition from responses where id = ${responseId} and error is null
  `;
  if (!r) throw new ProjectAccessError();
  const cites = await sql`select distinct url, domain from response_citations where response_id = ${responseId} order by domain, url limit 50`;
  return {
    id: r.id as string,
    question: r.promptText as string,
    answer: (r.responseText as string | null) ?? null,
    providerLabel: clientProviderLabel(r.provider as string),
    model: r.model as string,
    capturedAt: r.requestedAt as Date,
    repetition: Number(r.repetition),
    citations: cites.map((c) => ({ url: c.url as string, domain: c.domain as string })),
  };
}

// --------------------------------------------------------------- the plan

export interface ClientPlanItem {
  id: string;
  title: string;
  why: string;
  owner: string;
  dueOn: string | null;
  state: WorkState;
  dependsOn: string[];
  proofUrl: string | null;
  targetUrl: string | null;
  now: string | null;
  waitingNote: string | null;
  evidenceCount: number;
}

export interface ClientPlan {
  title: string;
  publishedAt: Date | null;
  phases: (PhaseWindow & { items: ClientPlanItem[]; progress: PhaseProgress })[];
}

export async function portalPlan(user: CurrentUser, projectId: string): Promise<ClientPlan | null> {
  await assertProjectAccess(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const plan = await planForProject(projectId, { publishedOnly: true });
  if (!plan) return null;
  const titles = new Map(plan.items.map((i) => [i.id, i.title]));
  const items: (ClientPlanItem & { phase: string })[] = plan.items
    .filter((i) => i.state !== "dropped")
    .map((i) => {
      // Task detail passes only when the agency made the task client-visible.
      const t = i.task && i.task.clientVisible ? i.task : null;
      return {
        id: i.id,
        phase: i.phase,
        title: i.title,
        why: i.rationale,
        owner: i.owner === "operator" ? "Recommended First" : i.owner === "client" ? "You" : "Together",
        dueOn: i.dueOn,
        state: i.state,
        dependsOn: i.dependsOn.map((d) => titles.get(d) ?? "another item"),
        proofUrl: i.proofUrl,
        targetUrl: t?.targetUrl ?? null,
        now: i.state === "completed" ? (t?.afterState ?? null) : null,
        waitingNote: i.state === "blocked" ? (t?.blockedNote ?? (t?.clientApproval === "required" ? "Waiting for your approval." : null)) : null,
        evidenceCount: t?.evidenceCount ?? 0,
      };
    });
  const progress = phaseProgress(items.map((i) => ({ phase: i.phase, state: i.state })));
  return {
    title: plan.title,
    publishedAt: plan.approvedAt,
    phases: phaseWindows(e.startsOn).map((w) => ({
      ...w,
      items: items.filter((i) => i.phase === w.key).map(({ phase: _p, ...rest }) => {
        void _p;
        return rest;
      }),
      progress: progress.find((p) => p.key === w.key)!,
    })),
  };
}

// --------------------------------------------------------------- approvals

export interface ClientDecisionView {
  decision: string;
  channel: string;
  clientActor: string | null;
  note: string;
  decidedAt: Date;
  wording: string | null;
}

export interface ClientChangeRequest {
  id: string;
  title: string;
  status: "waiting" | "approved" | "declined" | "edit_requested";
  why: string | null;
  targetUrl: string | null;
  currentText: string | null;
  proposedText: string | null;
  evidenceCount: number;
  history: ClientDecisionView[];
}

export interface ClientApprovals {
  details: { label: string; confirmed: boolean }[];
  /** Spec 155 R5: the current confirmed details (latest intake decision). */
  confirmedDetails: (import("@/lib/engagements/client-onboarding").ConfirmedDetails & { canCorrect: boolean }) | null;
  questionSet: (Omit<ProposedQuestionSet, "decision" | "setId"> & { status: "awaiting" | "approved" | "changes_requested"; segments: { priceTier: string; count: number }[] }) | null;
  protocol: { version: number; status: string; providerLabel: string; model: string; geographicContext: string; repetitions: number; baselineWindow: string; finalWindow: string; recommendationRubric: string; comparisonRules: string; caveats: string; adjudication: string; successCriteria: string; nameVariants: string[]; externalSources: string; acceptedAt: Date | null; acceptedByName: string | null } | null;
  changes: ClientChangeRequest[];
  decisions: { subject: string; decision: string; channel: string; clientActor: string; note: string; decidedAt: Date }[];
}

const SUBJECT_LABELS: Record<string, string> = {
  question_set: "Question set",
  protocol: "Measurement protocol",
  roadmap: "90-day plan",
  intake: "Business details",
  final_review: "Day-90 review",
  other: "Other",
};

export async function portalApprovals(user: CurrentUser, projectId: string): Promise<ClientApprovals | null> {
  await assertProjectAccess(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const context = await listContextItems(e.id);
  // Details on file: what we hold, and whether the client confirmed it.
  // Access items show their state only; notes and sources stay internal.
  const details = context
    .filter((c) => c.kind !== "note" && c.kind !== "excluded_competitor")
    .map((c) => ({ label: c.kind === "access" ? `${c.label} — ${String(c.accessStatus ?? "").replace(/_/g, " ")}` : c.label, confirmed: c.provenance !== "publicly_observed" }));
  const qs = await proposedQuestionSet(e.id, e.projectId);
  const protocols = await listProtocols(e.id);
  const protocol = protocols.find((p) => p.status === "accepted") ?? protocols.find((p) => p.status === "draft") ?? null;
  const tasks = await sql`
    select id, title, status, client_approval, hypothesis, observation, target_url, before_state, after_state, cardinality(evidence_ids) as evidence_count
    from tasks where project_id = ${projectId} and client_visible and client_approval <> 'not_required'
    order by (client_approval = 'required') desc, updated_at desc
  `;
  const ids = tasks.map((t) => t.id as string);
  const history = ids.length > 0
    ? await sql`
        select task_id, decision, channel, client_actor, note, decided_at, wording_snapshot from task_client_decisions
        where task_id = any(${ids}::uuid[]) order by decided_at desc`
    : [];
  const statusOf = (a: string): ClientChangeRequest["status"] => (a === "approved" ? "approved" : a === "rejected" ? "declined" : a === "edit_requested" ? "edit_requested" : "waiting");
  const decisions = await listSubjectDecisions(e.id);
  const { currentClientDetails, onboardingForEngagement } = await import("@/lib/engagements/client-onboarding");
  const [confirmed, onboardingRow] = await Promise.all([currentClientDetails(e.id), onboardingForEngagement(e.id)]);
  const segCounts = new Map<string, number>();
  for (const q of qs?.questions ?? []) segCounts.set(q.priceTier ?? "Unspecified", (segCounts.get(q.priceTier ?? "Unspecified") ?? 0) + 1);
  return {
    details,
    confirmedDetails: confirmed
      ? { ...confirmed, canCorrect: isClientApprover(user) && onboardingRow?.status === "completed" && ["onboarding", "active"].includes(e.stage) }
      : null,
    questionSet: qs
      ? {
          setName: qs.setName,
          versionId: qs.versionId,
          version: qs.version,
          frozenAt: qs.frozenAt,
          questions: qs.questions,
          segments: [...segCounts.entries()].map(([priceTier, count]) => ({ priceTier, count })),
          status: qs.decision?.decision === "approved" ? "approved" : qs.decision && qs.decision.decision !== "acknowledged" ? "changes_requested" : "awaiting",
        }
      : null,
    protocol: protocol
      ? { version: protocol.version, status: protocol.status, providerLabel: clientProviderLabel(protocol.provider), model: protocol.model, geographicContext: protocol.geographicContext, repetitions: protocol.repetitions, baselineWindow: protocol.baselineWindow, finalWindow: protocol.finalWindow, recommendationRubric: protocol.recommendationRubric, comparisonRules: protocol.comparisonRules, caveats: protocol.caveats, adjudication: protocol.adjudication, successCriteria: protocol.successCriteria, nameVariants: protocol.entityAliases, externalSources: protocol.externalSources, acceptedAt: protocol.acceptedAt, acceptedByName: protocol.acceptedByName }
      : null,
    changes: tasks.map((t) => ({
      id: t.id as string,
      title: t.title as string,
      status: statusOf(t.clientApproval as string),
      why: (t.hypothesis as string | null) ?? (t.observation as string | null) ?? null,
      targetUrl: (t.targetUrl as string | null) ?? null,
      currentText: (t.beforeState as string | null) ?? null,
      proposedText: (t.afterState as string | null) ?? null,
      evidenceCount: Number(t.evidenceCount ?? 0),
      history: history
        .filter((h) => h.taskId === t.id)
        .map((h) => ({ decision: h.decision as string, channel: h.channel as string, clientActor: (h.clientActor as string | null) ?? null, note: (h.note as string) ?? "", decidedAt: h.decidedAt as Date, wording: (h.wordingSnapshot as string | null) ?? null })),
    })),
    decisions: decisions.map((d) => ({ subject: SUBJECT_LABELS[d.subjectKind] ?? d.subjectKind, decision: d.decision, channel: d.channel, clientActor: d.clientActor, note: d.note, decidedAt: d.decidedAt })),
  };
}

// ---------------------------------------------------------------- reports

export interface ClientUpdatesView {
  updates: Pick<UpdateRow, "id" | "kind" | "periodStart" | "periodEnd" | "sentAt" | "body">[];
  meetings: Pick<MeetingRow, "id" | "kind" | "scheduledFor" | "agenda" | "status" | "notes" | "actionItems">[];
  nextCheckinDue: string | null;
}

export async function portalUpdates(user: CurrentUser, projectId: string, today = todayIso()): Promise<ClientUpdatesView | null> {
  await assertProjectAccess(user, projectId);
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const updates = (await listUpdates(e.id, { sentOnly: true })).map(({ id, kind, periodStart, periodEnd, sentAt, body }) => ({ id, kind, periodStart, periodEnd, sentAt, body }));
  const meetings = (await listMeetings(e.id, { clientVisibleOnly: true }))
    .filter((m) => m.status !== "cancelled")
    .map(({ id, kind, scheduledFor, agenda, status, notes, actionItems }) => ({ id, kind, scheduledFor, agenda, status, notes: status === "held" ? notes : "", actionItems: status === "held" ? actionItems : [] }));
  const state = await deliveryState(projectId, today);
  return { updates, meetings, nextCheckinDue: state?.nextCheckin.date ?? null };
}
