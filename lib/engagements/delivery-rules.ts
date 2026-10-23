/**
 * Client delivery rules (spec 154). Pure: no DB, no env. Everything the
 * operator delivery page, the portal and the tests reason about — the
 * journey, plan phases and item states, weekly/welcome text, the comparable
 * rate and its interval, segment breakdowns, offboarding — is derived here
 * from plain inputs so the same rule answers everywhere and nothing is ever
 * typed "done".
 */
import { findCausalPhrase } from "@/lib/workflow/gates";
import type { EngagementStage } from "@/lib/engagements/constants";
import {
  addDays,
  composeWeeklyUpdate,
  daysBetween,
  type MeasurementComparability,
  type MeasurementSnapshot,
} from "@/lib/engagements/rules";

// ------------------------------------------------------------- constants

export const DELIVERY_RULES_VERSION = "client-delivery-v1";
export const CHECKIN_CADENCE_DAYS = 14;
export const WEEKLY_WINDOW_DAYS = 7;
/** Weekly updates older than this (plus one grace day) mark cadence late. */
export const WEEKLY_GRACE_DAYS = 1;
/** Two-sided 95% normal quantile. */
export const Z_95 = 1.959964;
export const WEEKLY_UPDATE_BODY_VERSION = "weekly-update-v1";
export const WELCOME_BODY_VERSION = "welcome-v1";
/** Upper bound of an external raw export pasted into the importer (bytes). */
export const EXTERNAL_RAW_EXPORT_MAX = 2_000_000;

export const PLAN_PHASES = [
  { key: "foundation", label: "Days 1–30", title: "Foundation", fromDay: 0, toDay: 30 },
  { key: "authority", label: "Days 31–60", title: "Authority", fromDay: 30, toDay: 60 },
  { key: "compounding", label: "Days 61–90", title: "Compounding", fromDay: 60, toDay: 90 },
] as const;
export type PlanPhaseKey = (typeof PLAN_PHASES)[number]["key"];

export const DECISION_SUBJECTS = ["question_set", "protocol", "roadmap", "intake", "final_review", "other"] as const;
export type DecisionSubject = (typeof DECISION_SUBJECTS)[number];
export const SUBJECT_DECISIONS = ["approved", "changes_requested", "rejected", "acknowledged"] as const;
export type SubjectDecision = (typeof SUBJECT_DECISIONS)[number];
export const UPDATE_KINDS = ["welcome", "weekly", "final_review"] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];
export const MEETING_KINDS = ["kickoff", "checkin", "final_review"] as const;
export type MeetingKind = (typeof MEETING_KINDS)[number];
export const MEETING_STATUSES = ["planned", "held", "cancelled"] as const;
export const EXTERNAL_QA_STATUSES = ["pending", "verified", "rejected"] as const;
export const RECOMMENDATION_DISTINCTION = ["yes", "no", "unknown"] as const;

/** How a provider is named to a client. Never "ChatGPT" for an API sample. */
export const CLIENT_PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI model via the API (with web search)",
  anthropic: "Anthropic model via the API",
  google: "Google Gemini model via the API",
  perplexity: "Perplexity via the API",
  mock: "Test instrument (synthetic data)",
};
export function clientProviderLabel(provider: string): string {
  return CLIENT_PROVIDER_LABELS[provider] ?? provider;
}

/** Caveats every client-facing number carries. Plain words, no hedging tricks. */
export const MEASUREMENT_CAVEATS: readonly string[] = [
  "These answers come from a model accessed through its API. The consumer ChatGPT app can answer differently, and this sample does not represent all ChatGPT usage.",
  "Being mentioned is not counted as being recommended. Only answers that actively recommend you count.",
  "A source cited in an answer appears alongside the recommendation; it does not prove the source caused it.",
  "AI answers vary from run to run. Small movements can be noise; the interval shows the plausible range.",
];

// ------------------------------------------------------------ statistics

export interface Interval {
  low: number;
  high: number;
}

/** Wilson score interval for k successes in n trials (95%). */
export function wilsonInterval(k: number, n: number, z = Z_95): Interval | null {
  if (n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** Newcombe's hybrid score interval for p2 − p1 (method 10), 95%. */
export function differenceInterval(k1: number, n1: number, k2: number, n2: number, z = Z_95): Interval | null {
  const a = wilsonInterval(k1, n1, z);
  const b = wilsonInterval(k2, n2, z);
  if (!a || !b) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const d = p2 - p1;
  const low = d - Math.sqrt((p2 - b.low) ** 2 + (a.high - p1) ** 2);
  const high = d + Math.sqrt((b.high - p2) ** 2 + (p1 - a.low) ** 2);
  return { low: Math.max(-1, low), high: Math.min(1, high) };
}

// ------------------------------------------------------------ plan phases

export interface PhaseWindow {
  key: PlanPhaseKey;
  title: string;
  label: string;
  from: string;
  to: string;
}

export function phaseWindows(startsOn: string): PhaseWindow[] {
  return PLAN_PHASES.map((p) => ({
    key: p.key,
    title: p.title,
    label: p.label,
    from: addDays(startsOn, p.fromDay),
    to: addDays(startsOn, p.toDay - 1),
  }));
}

/** Engagement day number (Day 1 = start date); null before the start. */
export function engagementDay(startsOn: string, today: string): number | null {
  const d = daysBetween(startsOn, today);
  return d < 0 ? null : d + 1;
}

export const WORK_STATES = ["proposed", "in_progress", "blocked", "completed", "dropped"] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const WORK_STATE_LABELS: Record<WorkState, string> = {
  proposed: "Proposed",
  in_progress: "In progress",
  blocked: "Blocked",
  completed: "Completed",
  dropped: "Dropped",
};

/** One client-facing state per plan item, from the item and its linked task. */
export function planItemState(item: {
  status: string;
  task: { status: string; blockedReason: string | null; clientApproval: string } | null;
}): WorkState {
  if (item.status === "dropped" || item.status === "excluded") return "dropped";
  const t = item.task;
  if (t) {
    if (t.status === "done") return "completed";
    if (t.status === "rejected") return "dropped";
    if (t.blockedReason || t.clientApproval === "required" || t.clientApproval === "edit_requested") return "blocked";
    if (t.status === "in_progress" || t.status === "approved") return "in_progress";
    return "proposed";
  }
  if (item.status === "done") return "completed";
  if (item.status === "in_progress") return "in_progress";
  return "proposed";
}

export interface PhaseProgress {
  key: PlanPhaseKey;
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
}

export function phaseProgress(items: { phase: string; state: WorkState }[]): PhaseProgress[] {
  return PLAN_PHASES.map((p) => {
    const inPhase = items.filter((i) => i.phase === p.key && i.state !== "dropped");
    return {
      key: p.key,
      total: inPhase.length,
      completed: inPhase.filter((i) => i.state === "completed").length,
      inProgress: inPhase.filter((i) => i.state === "in_progress").length,
      blocked: inPhase.filter((i) => i.state === "blocked").length,
    };
  });
}

// ------------------------------------------------------------ the journey

export const JOURNEY_STEP_KEYS = [
  "commercial",
  "welcome",
  "details",
  "questions",
  "protocol",
  "baseline",
  "roadmap",
  "delivery",
  "final_review",
  "closed",
] as const;
export type JourneyStepKey = (typeof JOURNEY_STEP_KEYS)[number];
export type StepState = "done" | "current" | "blocked" | "upcoming";

export interface JourneyStep {
  key: JourneyStepKey;
  clientLabel: string;
  operatorLabel: string;
  state: StepState;
  detail: string;
  /** What the operator does next when this step is current. */
  operatorAction: string;
  /** What the client is asked to do, when anything. */
  clientAction: string | null;
}

export interface JourneyInput {
  stage: EngagementStage;
  commercialReady: boolean;
  commercialReasons: string[];
  portalGrants: number;
  welcomeSent: boolean;
  intakeConfirmed: boolean;
  questionSet: { versionId: string; questionCount: number; approved: boolean; changesRequested: boolean } | null;
  protocol: { status: "draft" | "accepted"; questionSetApproved: boolean } | null;
  baselineFrozen: boolean;
  roadmapPublished: boolean;
  lastWeeklySentOn: string | null;
  nextCheckinOn: string | null;
  finalMeasured: boolean;
  finalReviewSent: boolean;
  today: string;
}

export function deliveryJourney(i: JourneyInput): JourneyStep[] {
  const closed = i.stage === "completed" || i.stage === "churned" || i.stage === "renewed";
  type Draft = Omit<JourneyStep, "state"> & { done: boolean; blocked?: boolean };
  const steps: Draft[] = [];
  const add = (s: Draft) => steps.push(s);
  const commercialDone = i.stage !== "signed";
  add({
    key: "commercial",
    clientLabel: "Agreement in place",
    operatorLabel: "Contract signed and activation payment recorded",
    done: commercialDone,
    blocked: !commercialDone && !i.commercialReady,
    detail: commercialDone ? "Commercial gate passed." : i.commercialReady ? "Gate clear — start onboarding." : i.commercialReasons.join(" "),
    operatorAction: i.commercialReady ? "Start onboarding on the engagement page." : `Clear the commercial gate: ${i.commercialReasons.join(" ")}`,
    clientAction: null,
  });
  add({
    key: "welcome",
    clientLabel: "Welcome and portal access",
    operatorLabel: "Portal access granted and welcome message sent",
    done: i.portalGrants > 0 && i.welcomeSent,
    detail: `${i.portalGrants} portal login(s); welcome ${i.welcomeSent ? "sent" : "not sent"}.`,
    operatorAction: i.portalGrants === 0 ? "Invite the primary contact to the portal (admin), then send the welcome message." : "Generate the welcome message, send it from your mailbox, then mark it sent.",
    clientAction: null,
  });
  add({
    key: "details",
    clientLabel: "Confirm your business details",
    operatorLabel: "Intake confirmed with the client",
    done: i.intakeConfirmed,
    detail: i.intakeConfirmed ? "Client-confirmed details on file." : "Prefilled details still need the client's confirmation.",
    operatorAction: "Walk the prefilled intake with the client and record what they confirm.",
    clientAction: "Check the details we have on file and tell us anything that is wrong.",
  });
  const qs = i.questionSet;
  add({
    key: "questions",
    clientLabel: "Approve the questions we will measure",
    operatorLabel: "Question set imported, frozen and approved by the client",
    done: Boolean(qs?.approved),
    blocked: Boolean(qs?.changesRequested && !qs.approved),
    detail: qs ? `${qs.questionCount} questions proposed; ${qs.approved ? "approved" : qs.changesRequested ? "changes requested" : "awaiting the client's review"}.` : "No question set proposed yet.",
    operatorAction: qs ? (qs.changesRequested ? "Revise the questions, import a new version and share it again." : "Send the question review and record the client's decision.") : "Import the client-reviewed questions (CSV) and freeze them as the proposed version.",
    clientAction: qs && !qs.approved ? "Review the proposed questions and reply with approval or changes." : null,
  });
  const protocolAccepted = i.protocol?.status === "accepted";
  add({
    key: "protocol",
    clientLabel: "Agree how success is measured",
    operatorLabel: "Measurement protocol accepted",
    done: protocolAccepted,
    detail: protocolAccepted ? "Protocol accepted and frozen." : i.protocol ? "Draft protocol waiting for acceptance." : "No protocol drafted yet.",
    operatorAction: i.protocol ? "Share the protocol and record the client's acceptance." : "Draft the measurement protocol over the approved question set.",
    clientAction: i.protocol && !protocolAccepted ? "Review the measurement plan and confirm it." : null,
  });
  add({
    key: "baseline",
    clientLabel: "Starting point measured",
    operatorLabel: "Baseline run captured, reviewed and locked",
    done: i.baselineFrozen,
    detail: i.baselineFrozen ? "Baseline locked." : "No baseline yet — results stay pending.",
    operatorAction: "Run the baseline on the protocol's questions, clear parsing and review, then lock it.",
    clientAction: null,
  });
  add({
    key: "roadmap",
    clientLabel: "Your 90-day plan",
    operatorLabel: "Roadmap drafted, reviewed and published",
    done: i.roadmapPublished,
    detail: i.roadmapPublished ? "Plan published to the client." : "Plan not published yet.",
    operatorAction: "Draft the plan from the baseline findings, add dates and owners, then publish it.",
    clientAction: null,
  });
  const weeklyLate = i.lastWeeklySentOn === null || daysBetween(i.lastWeeklySentOn, i.today) > WEEKLY_WINDOW_DAYS + WEEKLY_GRACE_DAYS;
  add({
    key: "delivery",
    clientLabel: "Work, weekly updates and check-ins",
    operatorLabel: "Delivery cadence: weekly update and check-in every two weeks",
    done: false,
    detail: `${i.lastWeeklySentOn ? `Last weekly update ${i.lastWeeklySentOn}` : "No weekly update sent yet"}; ${i.nextCheckinOn ? `next check-in ${i.nextCheckinOn}` : "no check-in scheduled"}.`,
    operatorAction: weeklyLate ? "Generate, review and send this week's update." : i.nextCheckinOn ? "Work the plan." : "Schedule the next check-in.",
    clientAction: null,
  });
  add({
    key: "final_review",
    clientLabel: "Day-90 results review",
    operatorLabel: "Final measurement frozen and review sent",
    done: i.finalMeasured && i.finalReviewSent,
    detail: i.finalMeasured ? (i.finalReviewSent ? "Final review sent." : "Final measurement frozen; review not sent.") : "Final measurement not taken yet.",
    operatorAction: i.finalMeasured ? "Prepare and send the Day-90 review." : "Run the final measurement on the same instrument and record it.",
    clientAction: null,
  });
  add({
    key: "closed",
    clientLabel: "Wrap-up and next steps",
    operatorLabel: "Engagement closed or renewed",
    done: closed,
    detail: closed ? `Engagement ${i.stage}.` : "Open.",
    operatorAction: "Run the offboarding checklist, then close or renew.",
    clientAction: null,
  });

  // Delivery is ongoing work, not a box to tick: it counts as done once the
  // final measurement exists (or the engagement closed).
  let currentAssigned = false;
  return steps.map(({ done, blocked, ...rest }) => {
    const isDone = done || (rest.key === "delivery" && (i.finalMeasured || closed));
    let state: StepState = "upcoming";
    if (isDone) state = "done";
    else if (!currentAssigned) {
      state = blocked ? "blocked" : "current";
      currentAssigned = true;
    }
    return { ...rest, state };
  });
}

export function currentStep(steps: JourneyStep[]): JourneyStep | null {
  return steps.find((s) => s.state === "current" || s.state === "blocked") ?? null;
}

// ------------------------------------------------------- check-in cadence

/** The next check-in date: the earliest planned meeting, else 14 days after
 * the last held one, else the engagement start + 14. */
export function nextCheckinDue(input: {
  startsOn: string;
  planned: string[];
  lastHeld: string | null;
}): { date: string; scheduled: boolean } {
  const planned = [...input.planned].sort()[0];
  if (planned) return { date: planned, scheduled: true };
  return { date: addDays(input.lastHeld ?? input.startsOn, CHECKIN_CADENCE_DAYS), scheduled: false };
}

// ------------------------------------------------------------- welcome

export interface WelcomeInput {
  clientName: string;
  contactName: string;
  agencyContactName: string;
  marketName: string;
  scopeSummary: string;
  startsOn: string;
  endsOn: string;
  portalUrl: string | null;
  nextAction: string;
  firstCheckinOn: string | null;
}

export interface UpdateBody {
  version: string;
  sections: { title: string; lines: string[] }[];
  text: string;
  /** Canonical row references behind the body (task, measurement, plan item ids). */
  refs: { kind: string; id: string }[];
}

export function composeWelcome(i: WelcomeInput): UpdateBody {
  const first = i.contactName.trim().split(/\s+/)[0] || i.contactName;
  const sections = [
    { title: "What we are doing together", lines: [i.scopeSummary, `Market: ${i.marketName}. Term: ${i.startsOn} to ${i.endsOn}.`] },
    { title: "Your contact", lines: [`${i.agencyContactName} runs your engagement. Reply to this email any time.`] },
    { title: "What happens next", lines: [i.nextAction, i.firstCheckinOn ? `First check-in: ${i.firstCheckinOn}. We meet every two weeks.` : "We will propose a time for our first check-in."] },
    {
      title: "Your private portal",
      lines: i.portalUrl
        ? [`Sign in at ${i.portalUrl} with this email address. We will never ask for a password.`, "Results show as pending until the first agreed measurement is complete."]
        : ["Portal access will follow in a separate email."],
    },
  ];
  const text = [
    `Hi ${first},`,
    "",
    `Welcome to Recommended First. Here is a short summary of your engagement for ${i.clientName}.`,
    "",
    ...sections.flatMap((s) => [s.title.toUpperCase(), ...s.lines.map((l) => `- ${l}`), ""]),
    `${i.agencyContactName}`,
  ].join("\n");
  return { version: WELCOME_BODY_VERSION, sections, text, refs: [] };
}

// ---------------------------------------------------------- weekly body

export interface WeeklyInput {
  clientName: string;
  periodStart: string;
  periodEnd: string;
  intro: string;
  done: { taskId: string; title: string; targetUrl: string | null; after: string | null; evidenceCount: number }[];
  inProgress: { taskId: string; title: string }[];
  blocked: { taskId: string; title: string; reason: string; note: string | null; onClient: boolean }[];
  approvals: { taskId: string; title: string }[];
  measurements: { measurementId: string; role: string; statement: string; grade: string }[];
  baselineFrozen: boolean;
  dueNext: { itemId: string; title: string; dueOn: string; owner: string }[];
  nextCheckinOn: string | null;
}

export function weeklyMeasurementLine(i: Pick<WeeklyInput, "measurements" | "baselineFrozen">): string {
  if (i.measurements.length > 0) {
    return i.measurements
      .map((m) => (m.grade === "not_comparable" ? `- A ${m.role} measurement was recorded but is not comparable with the baseline, so no change is reported.` : `- ${m.statement} (comparability: ${m.grade.replace(/_/g, " ")}).`))
      .join("\n");
  }
  return i.baselineFrozen
    ? "- No comparable measurement was taken this week, so no change in AI visibility is reported."
    : "- The baseline has not been measured yet, so there are no visibility results to report.";
}

export function composeWeeklyBody(i: WeeklyInput): UpdateBody {
  const done = i.done.map((d) => `${d.title}${d.targetUrl ? ` (${d.targetUrl})` : ""}${d.after ? ` — now: ${d.after}` : ""}`);
  const needFromYou = [
    ...i.approvals.map((a) => `Approve or edit: ${a.title}`),
    ...i.blocked.filter((b) => b.onClient).map((b) => `${b.title}${b.note ? ` — ${b.note}` : ""}`),
  ];
  const next = [
    ...i.dueNext.map((d) => `${d.title} (due ${d.dueOn}, ${d.owner})`),
    ...(i.nextCheckinOn ? [`Check-in on ${i.nextCheckinOn}`] : []),
  ];
  const measurement = weeklyMeasurementLine(i);
  const core = composeWeeklyUpdate({
    clientName: i.clientName,
    weekEnding: i.periodEnd,
    done,
    inProgress: i.inProgress.map((t) => t.title),
    needFromYou,
    measurement: i.measurements.length > 0 ? measurement : null,
    noMeasurementLine: measurement,
    next,
  });
  const blockedOnUs = i.blocked.filter((b) => !b.onClient);
  const blockedText = blockedOnUs.length > 0 ? `\n\nBLOCKED ON OUR SIDE\n${blockedOnUs.map((b) => `- ${b.title} (${b.reason.replace(/_/g, " ")})`).join("\n")}` : "";
  const intro = i.intro.trim();
  const text = intro ? core.replace("\n\n", `\n\n${intro}\n\n`) + blockedText : core + blockedText;
  const sections = [
    { title: "Done this week", lines: done },
    { title: "In progress", lines: i.inProgress.map((t) => t.title) },
    { title: "Needs your input", lines: needFromYou },
    { title: "Blocked on our side", lines: blockedOnUs.map((b) => b.title) },
    { title: "Measurement", lines: measurement.split("\n").map((l) => l.replace(/^- /, "")) },
    { title: "Next week", lines: next },
  ];
  const refs = [
    ...i.done.map((d) => ({ kind: "task", id: d.taskId })),
    ...i.inProgress.map((d) => ({ kind: "task", id: d.taskId })),
    ...i.blocked.map((d) => ({ kind: "task", id: d.taskId })),
    ...i.approvals.map((d) => ({ kind: "task", id: d.taskId })),
    ...i.measurements.map((m) => ({ kind: "measurement", id: m.measurementId })),
    ...i.dueNext.map((d) => ({ kind: "plan_item", id: d.itemId })),
  ];
  return { version: WEEKLY_UPDATE_BODY_VERSION, sections, text, refs };
}

/** Operator-written prose in a client update may not state numbers as
 * percentages or claim causality — numbers come only from the canonical
 * sections. */
export function operatorNoteIssues(note: string): string[] {
  const issues: string[] = [];
  if (/\d\s*%|percent/i.test(note)) issues.push("Do not state percentages in the note; measurement lines come from frozen snapshots.");
  const causal = findCausalPhrase(note);
  if (causal) issues.push(`Causal claim ("${causal}") — describe what changed, not what it caused.`);
  return issues;
}

// --------------------------------------------------- comparable results

export interface MeasurementLike {
  id: string;
  role: string;
  status: string;
  frozenAt: Date | null;
  snapshot: MeasurementSnapshot | null;
  comparability: MeasurementComparability | null;
}

/** The one rate a client sees: the latest comparable snapshot, else the
 * baseline, else nothing (pending — never zero). */
export function latestComparable<T extends MeasurementLike>(rows: T[]): { baseline: T | null; latest: T | null } {
  const baseline = rows.find((m) => m.role === "baseline" && m.status === "frozen" && m.snapshot) ?? null;
  const later = rows
    .filter((m) => m.role !== "baseline" && m.status === "frozen" && m.snapshot && m.frozenAt && m.comparability && m.comparability.grade !== "not_comparable")
    .sort((a, b) => b.frozenAt!.getTime() - a.frozenAt!.getTime())[0];
  return { baseline, latest: later ?? baseline };
}

export interface RateView {
  recommended: number;
  answers: number;
  rate: number;
  interval: Interval | null;
  questions: number;
  distinctQuestions: number;
  provider: string;
  providerLabel: string;
  models: string[];
  capturedAt: string | null;
  scoringVersion: string;
  methodologyVersion: string;
  repetitions: number;
}

export function rateView(s: MeasurementSnapshot): RateView | null {
  if (s.answerCount <= 0) return null;
  return {
    recommended: s.subject.recommendedCount,
    answers: s.answerCount,
    rate: s.subject.recommendedCount / s.answerCount,
    interval: wilsonInterval(s.subject.recommendedCount, s.answerCount),
    questions: s.questionCount,
    distinctQuestions: s.subject.distinctQuestions,
    provider: s.provider,
    providerLabel: clientProviderLabel(s.provider),
    models: s.models,
    capturedAt: s.capturedAt,
    scoringVersion: s.versions.scoringVersion,
    methodologyVersion: s.methodologyVersion,
    repetitions: s.repetitions,
  };
}

export const SEGMENT_DIMENSIONS = ["priceTier", "neighborhood", "audience"] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];
export const UNSPECIFIED_SEGMENT = "Unspecified";

export interface SegmentRow {
  segment: string;
  questions: number;
  answers: number;
  recommended: number;
  rate: number | null;
  competitorRecommended: Record<string, number>;
}

/** Per-segment counts from frozen question attributes. Old snapshots (before
 * spec 154) carry no attributes and land in "Unspecified". */
export function segmentBreakdown(s: MeasurementSnapshot, dim: SegmentDimension): SegmentRow[] {
  const map = new Map<string, SegmentRow>();
  for (const q of s.questions) {
    const key = (q.segment?.[dim] ?? "").trim() || UNSPECIFIED_SEGMENT;
    const row = map.get(key) ?? { segment: key, questions: 0, answers: 0, recommended: 0, rate: null, competitorRecommended: {} };
    row.questions += 1;
    row.answers += q.answerCount;
    row.recommended += q.subjectRecommended;
    for (const [c, n] of Object.entries(q.competitorRecommended)) row.competitorRecommended[c] = (row.competitorRecommended[c] ?? 0) + n;
    map.set(key, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, rate: r.answers > 0 ? r.recommended / r.answers : null }))
    .sort((a, b) => (a.segment === UNSPECIFIED_SEGMENT ? 1 : b.segment === UNSPECIFIED_SEGMENT ? -1 : 0) || priceSortKey(a.segment) - priceSortKey(b.segment) || a.segment.localeCompare(b.segment));
}

function priceSortKey(segment: string): number {
  return parsePriceBand(segment)?.min ?? Number.MAX_SAFE_INTEGER;
}

/** Question-level change between two comparable snapshots, grouped. */
export function questionChanges(baseline: MeasurementSnapshot, next: MeasurementSnapshot): {
  gained: string[];
  lost: string[];
  steady: number;
} {
  const after = new Map(next.questions.map((q) => [q.promptId, q]));
  const gained: string[] = [];
  const lost: string[] = [];
  let steady = 0;
  for (const q of baseline.questions) {
    const a = after.get(q.promptId);
    const before = q.subjectRecommended > 0;
    const now = (a?.subjectRecommended ?? 0) > 0;
    if (!before && now) gained.push(q.promptId);
    else if (before && !now) lost.push(q.promptId);
    else steady += 1;
  }
  return { gained, lost, steady };
}

// ---------------------------------------------------------- price bands

const AMOUNT = String.raw`\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?`;
const RANGE_RE = new RegExp(`${AMOUNT}\\s*(?:[–—-]|to)\\s*${AMOUNT}`);
const PLUS_RE = new RegExp(`${AMOUNT}\\s*\\+`);
const MONEY_IN_TEXT_RE = /\$\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([kKmM]\b)?/g;

function toUsd(num: string, unit: string | undefined): number {
  const n = Number(num.replace(/,/g, ""));
  const u = (unit ?? "").toLowerCase();
  return Math.round(u === "m" ? n * 1_000_000 : u === "k" ? n * 1_000 : n);
}

/** "$300K–$499K" → {min: 300000, max: 499000}; "$1.5M+" → {min: 1500000, max: null}. */
export function parsePriceBand(label: string): { min: number; max: number | null } | null {
  const r = RANGE_RE.exec(label);
  if (r) {
    const unitHigh = r[4];
    const unitLow = r[2] ?? unitHigh;
    return { min: toUsd(r[1]!, unitLow), max: toUsd(r[3]!, unitHigh) };
  }
  const p = PLUS_RE.exec(label);
  if (p) return { min: toUsd(p[1]!, p[2]), max: null };
  return null;
}

/** Dollar amounts written inside a question ("my $650K home"). */
export function moneyMentions(text: string): number[] {
  return [...text.matchAll(MONEY_IN_TEXT_RE)].map((m) => toUsd(m[1]!, m[2]?.trim()));
}

// -------------------------------------------------------- offboarding

export interface OffboardingInput {
  openTasks: number;
  finalMeasured: boolean;
  finalReviewSent: boolean;
  portalGrants: number;
  stage: EngagementStage;
  openMeetings: number;
}

export interface OffboardingItem {
  key: string;
  label: string;
  done: boolean;
  detail: string;
}

export function offboardingChecklist(i: OffboardingInput): OffboardingItem[] {
  const closed = i.stage === "completed" || i.stage === "churned" || i.stage === "renewed";
  return [
    { key: "final_measurement", label: "Final measurement recorded on the same instrument", done: i.finalMeasured, detail: i.finalMeasured ? "frozen" : "run and record the final measurement" },
    { key: "final_review", label: "Day-90 review sent", done: i.finalReviewSent, detail: i.finalReviewSent ? "sent and archived in the portal" : "prepare and send the review" },
    { key: "exports", label: "Client copy of evidence and final review exported", done: false, detail: "Manual: download the evidence package and the review, and send them to the client before access ends." },
    { key: "open_work", label: "Open work items closed or handed over", done: i.openTasks === 0, detail: `${i.openTasks} open item(s)` },
    { key: "meetings", label: "No check-ins left scheduled", done: i.openMeetings === 0, detail: `${i.openMeetings} planned` },
    { key: "access", label: "Portal access ended per policy", done: closed && i.portalGrants === 0, detail: closed ? `${i.portalGrants} grant(s) remain` : "closing the engagement revokes every grant" },
  ];
}

// ----------------------------------------------------- protocol defaults

/** Generic starting text for a protocol draft. Contract-specific values
 * (success criteria, windows, geography) are always typed by a person. */
export const PROTOCOL_DEFAULTS = {
  recommendationRubric:
    "An answer counts as a recommendation only when it actively suggests the business as one to hire or contact (for example, listed among recommended agents, or named as a good choice). A neutral mention, a directory listing without endorsement, or a warning does not count. Only the name variants listed in this protocol are credited to the client.",
  comparisonRules:
    "Before and after are compared only between snapshots taken on the same frozen question set, provider and model, number of repetitions, scoring version and name variants. Any difference is disclosed. A measurement on a different instrument is reported as not comparable, never as a change.",
  caveats: MEASUREMENT_CAVEATS.join("\n"),
  adjudication:
    "Before the baseline and the final measurement are locked, a person reviews every answer counted for or against the client and each tracked competitor. Disagreements are recorded next to the original answer. The client may inspect any counted answer and dispute it within the period agreed in the contract; disputed answers are re-reviewed jointly and the decision is recorded.",
  externalSources:
    "None. A third-party measurement tool, if used, is supplementary context reported separately. It is not used to decide success unless both parties add it to this protocol in writing, including whether it can tell a recommendation from a mention.",
} as const;

/** Fields an accepted protocol must state. */
export const PROTOCOL_REQUIRED_FIELDS = [
  "model",
  "geographicContext",
  "baselineWindow",
  "finalWindow",
  "recommendationRubric",
  "comparisonRules",
  "caveats",
  "adjudication",
  "successCriteria",
] as const;

export function protocolMissing(p: Record<(typeof PROTOCOL_REQUIRED_FIELDS)[number], string> & { entityAliases: string[] }): string[] {
  const missing: string[] = PROTOCOL_REQUIRED_FIELDS.filter((k) => !p[k] || p[k].trim().length === 0);
  if (p.entityAliases.length === 0) missing.push("entityAliases");
  return missing;
}

// ------------------------------------------------------- check-in agenda

export function defaultCheckinAgenda(i: { approvalsWaiting: number; blockedOnClient: number; dueNext: string[]; measurementPending: boolean }): string {
  return [
    "1. What we completed since the last check-in (with proof links).",
    i.approvalsWaiting > 0 ? `2. ${i.approvalsWaiting} change(s) waiting for your approval.` : "2. Approvals: nothing waiting.",
    i.blockedOnClient > 0 ? `3. ${i.blockedOnClient} item(s) need your input or access.` : "3. Nothing blocked on your side.",
    i.dueNext.length > 0 ? `4. Next two weeks: ${i.dueNext.slice(0, 4).join("; ")}.` : "4. Next two weeks: continue the current plan.",
    i.measurementPending ? "5. Measurement: the baseline is not locked yet; what is left before it is." : "5. Measurement: any new comparable measurement, with its caveats.",
    "6. Questions and anything you want us to change.",
  ].join("\n");
}

// ------------------------------------------------------ Day-90 review

export interface FinalReviewInput {
  clientName: string;
  baseline: RateView;
  final: RateView | null;
  comparability: MeasurementComparability | null;
  gainedQuestions: string[];
  lostQuestions: string[];
  deliveredWork: string[];
  successCriteria: string;
  externalNote: string | null;
}

export const FINAL_REVIEW_BODY_VERSION = "final-review-v1";
/** The sentence every Day-90 review carries. No code path decides a fee. */
export const OUTCOME_NOT_AUTOMATIC =
  "Whether the agreed success criteria were met is decided by you and Recommended First together under the agreed protocol. This summary reports the measurements; it does not decide the outcome or any fee.";

const pctText = (v: number) => `${Math.round(v * 1000) / 10}%`;

export function composeFinalReviewBody(i: FinalReviewInput): UpdateBody {
  const b = i.baseline;
  const lines: { title: string; lines: string[] }[] = [];
  lines.push({
    title: "Starting point (locked baseline)",
    lines: [`Recommended in ${b.recommended} of ${b.answers} valid answers (${pctText(b.rate)}; plausible range ${b.interval ? `${pctText(b.interval.low)}–${pctText(b.interval.high)}` : "n/a"}) from the ${b.providerLabel}, ${b.questions} questions × ${b.repetitions} repetitions.`],
  });
  if (!i.final) {
    lines.push({ title: "Final measurement", lines: ["No comparable final measurement exists, so no change is reported."] });
  } else if (!i.comparability || i.comparability.grade === "not_comparable") {
    lines.push({ title: "Final measurement", lines: [`The final measurement is not comparable with the baseline (${(i.comparability?.reasons ?? []).join("; ") || "instrument differs"}), so no change is reported.`] });
  } else {
    const f = i.final;
    const d = differenceInterval(b.recommended, b.answers, f.recommended, f.answers);
    lines.push({
      title: "Final measurement (same instrument)",
      lines: [
        `Recommended in ${f.recommended} of ${f.answers} valid answers (${pctText(f.rate)}).`,
        `Observed change: ${f.rate - b.rate >= 0 ? "+" : ""}${pctText(f.rate - b.rate)}${d ? ` (plausible range ${pctText(d.low)} to ${pctText(d.high)}, treating answers as independent; answers to the same question are correlated, so the true range is wider)` : ""}.`,
        `Comparability: ${i.comparability.grade}${i.comparability.reasons.length > 0 ? ` — ${i.comparability.reasons.join("; ")}` : ""}.`,
        "This is observed movement, not proof that any single change caused it.",
      ],
    });
    lines.push({ title: "Questions where you are now recommended", lines: i.gainedQuestions.length > 0 ? i.gainedQuestions : ["None."] });
    lines.push({ title: "Questions where you are no longer recommended", lines: i.lostQuestions.length > 0 ? i.lostQuestions : ["None."] });
  }
  lines.push({ title: "Work delivered", lines: i.deliveredWork.length > 0 ? i.deliveredWork : ["No completed work items were recorded."] });
  lines.push({ title: "Agreed success criteria", lines: [i.successCriteria || "Not recorded.", OUTCOME_NOT_AUTOMATIC] });
  if (i.externalNote) lines.push({ title: "Independent measurement", lines: [i.externalNote] });
  lines.push({ title: "Limitations", lines: [...MEASUREMENT_CAVEATS] });
  const text = [`Day-90 review — ${i.clientName}`, "", ...lines.flatMap((s) => [s.title.toUpperCase(), ...s.lines.map((l) => `- ${l}`), ""])].join("\n");
  return { version: FINAL_REVIEW_BODY_VERSION, sections: lines, text, refs: [] };
}
