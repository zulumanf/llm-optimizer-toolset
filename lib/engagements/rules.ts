/**
 * Pure engagement rules (spec 131). Client-safe: no DB, no env.
 *
 * Everything the operator page, the portal and the tests reason about —
 * commercial gate, onboarding completeness, measurement schedule,
 * measurement comparability and comparison, renewal state, weekly update
 * text — is derived here from plain inputs so the same rule answers
 * everywhere and a "done" can never be typed by hand.
 */
import {
  CLIENT_UPDATE_CADENCE_DAYS,
  type ContractStatus,
  DEFAULT_TERM_DAYS,
  type EngagementStage,
  FINAL_MEASUREMENT_DAYS_BEFORE_END,
  MEASUREMENT_ANSWER_RATIO_FLOOR,
  MEASUREMENT_REPETITION_RATIO_LIMIT,
  type MeasurementRole,
  MIDPOINT_MEASUREMENT_DAY,
  RENEWAL_REVIEW_DAYS_BEFORE_END,
  type RenewalStatus,
} from "@/lib/engagements/constants";

// ------------------------------------------------------------------ dates

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface TermDates {
  endsOn: string;
  renewalReviewOn: string;
}

/** Default term dates from a start date: end after the term, renewal
 * review three weeks before the end. */
export function termDates(startsOn: string, termDays = DEFAULT_TERM_DAYS): TermDates {
  const endsOn = addDays(startsOn, termDays);
  return { endsOn, renewalReviewOn: addDays(endsOn, -RENEWAL_REVIEW_DAYS_BEFORE_END) };
}

// ------------------------------------------------------- commercial gate

export interface CommercialGateInput {
  contractStatus: ContractStatus;
  /** Spec 140: cents required before activation (the first installment in full). */
  activationPaymentCents?: number;
  /** Sum of payment_received billing events, in cents. */
  paymentsReceivedCents: number;
  activationOverrideReason: string | null;
}

export interface GateVerdict {
  ready: boolean;
  reasons: string[];
}

/** SIGNED + FIRST_PAYMENT_CONFIRMED → onboarding may begin. A founder
 * override with a written reason stands in for the payment, never for the
 * contract. */
export function commercialGate(input: CommercialGateInput): GateVerdict {
  const reasons: string[] = [];
  if (input.contractStatus !== "signed") {
    reasons.push(`Contract is "${input.contractStatus}", not signed.`);
  }
  // Spec 140: the activation payment is the first installment in full, not
  // "any amount"; rows without an installment amount keep the > 0 rule.
  const required = input.activationPaymentCents ?? 0;
  if (!activationPaid(input)) {
    reasons.push(
      required > 0 && input.paymentsReceivedCents > 0
        ? `Activation payment incomplete: $${(input.paymentsReceivedCents / 100).toLocaleString("en-US")} of the required $${(required / 100).toLocaleString("en-US")} first installment received.`
        : "No payment received has been recorded (or a founder override with a reason)."
    );
  }
  return { ready: reasons.length === 0, reasons };
}

// ----------------------------------------------------------- onboarding

export interface OnboardingInput {
  contractStatus: ContractStatus;
  activationPaymentCents?: number;
  paymentsReceivedCents: number;
  activationOverrideReason: string | null;
  /** Subject company linked and a named primary contact recorded. */
  subjectLinked: boolean;
  primaryContactNamed: boolean;
  marketDefinitionConfirmed: boolean;
  exclusivityStatus: "active" | "reserved" | "terminated" | "none";
  exclusivityConflictFree: boolean;
  priorityItems: number;
  assetItems: number;
  accessRequestedOpen: number;
  baselineFrozen: boolean;
  planItems: number;
}

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  detail: string;
}

/** The activation payment condition alone (first installment in full, or a
 * written founder override) — shared by the gate and the checklist. */
export function activationPaid(i: { activationPaymentCents?: number; paymentsReceivedCents: number; activationOverrideReason: string | null }): boolean {
  const required = i.activationPaymentCents ?? 0;
  const paid = required > 0 ? i.paymentsReceivedCents >= required : i.paymentsReceivedCents > 0;
  return paid || Boolean(i.activationOverrideReason?.trim());
}

export function onboardingChecklist(i: OnboardingInput): ChecklistItem[] {
  const gate = commercialGate(i);
  return [
    {
      key: "agreement",
      label: "Agreement state known",
      done: i.contractStatus === "signed",
      detail: `contract ${i.contractStatus}`,
    },
    {
      key: "payment",
      label: "Payment state known",
      done: activationPaid(i),
      detail:
        i.paymentsReceivedCents > 0
          ? `payments received $${(i.paymentsReceivedCents / 100).toLocaleString("en-US")}`
          : i.activationOverrideReason
            ? `founder override: ${i.activationOverrideReason}`
            : gate.reasons.join(" "),
    },
    {
      key: "identity",
      label: "Client identity verified",
      done: i.subjectLinked && i.primaryContactNamed,
      detail: i.subjectLinked
        ? i.primaryContactNamed
          ? "canonical company linked; primary contact named"
          : "primary contact missing"
        : "no subject company on the project",
    },
    {
      key: "market_definition",
      label: "Market definition confirmed",
      done: i.marketDefinitionConfirmed,
      detail: i.marketDefinitionConfirmed
        ? "human-reviewed boundary recorded"
        : "write the boundary (city vs metro vs county) and confirm it",
    },
    {
      key: "exclusivity",
      label: "Exclusivity check passes",
      done: i.exclusivityStatus === "active" && i.exclusivityConflictFree,
      detail:
        i.exclusivityStatus === "active"
          ? i.exclusivityConflictFree
            ? "active agreement, no competing live client in the market"
            : "another live client overlaps this market"
          : `agreement ${i.exclusivityStatus}`,
    },
    {
      key: "priorities",
      label: "Top business priorities captured",
      done: i.priorityItems > 0,
      detail: `${i.priorityItems} client-priority item(s)`,
    },
    {
      key: "assets",
      label: "Key assets inventoried",
      done: i.assetItems > 0,
      detail: `${i.assetItems} asset(s)`,
    },
    {
      key: "access",
      label: "Required access resolved",
      done: i.accessRequestedOpen === 0,
      detail:
        i.accessRequestedOpen === 0
          ? "no access request still open"
          : `${i.accessRequestedOpen} access request(s) still open`,
    },
    {
      key: "baseline",
      label: "Baseline frozen",
      done: i.baselineFrozen,
      detail: i.baselineFrozen ? "immutable baseline package exists" : "freeze the baseline",
    },
    {
      key: "plan",
      label: "First implementation plan ready",
      done: i.planItems > 0,
      detail: `${i.planItems} work item(s) identified with evidence`,
    },
  ];
}

export function onboardingComplete(items: ChecklistItem[]): boolean {
  return items.every((i) => i.done);
}

// --------------------------------------------------------- measurements

export interface PlannedMeasurement {
  role: MeasurementRole;
  scheduledFor: string;
  reason: string;
}

/** Day 0 baseline is frozen from the pre-sale benchmark; the schedule adds a
 * mid-term diagnostic and the formal end-of-term remeasurement. */
export function measurementSchedule(startsOn: string, endsOn: string): PlannedMeasurement[] {
  const midpoint = addDays(startsOn, MIDPOINT_MEASUREMENT_DAY);
  const final = addDays(endsOn, -FINAL_MEASUREMENT_DAYS_BEFORE_END);
  const plan: PlannedMeasurement[] = [];
  if (daysBetween(startsOn, midpoint) < daysBetween(startsOn, final)) {
    plan.push({
      role: "midpoint",
      scheduledFor: midpoint,
      reason: "Mid-term diagnostic remeasurement over the baseline question set.",
    });
  }
  plan.push({
    role: "final",
    scheduledFor: final,
    reason: "Formal end-of-term remeasurement over the baseline question set.",
  });
  return plan;
}

export interface SnapshotEntity {
  companyId: string;
  name: string;
  aliases: string[];
  recommendedCount: number;
  distinctQuestions: number;
}

export interface SnapshotQuestion {
  promptId: string;
  text: string;
  category: string | null;
  answerCount: number;
  subjectRecommended: number;
  competitorRecommended: Record<string, number>;
  /** Raw answer references — the immutable evidence behind every count. */
  responseIds: string[];
}

export interface MeasurementSnapshot {
  methodologyVersion: string;
  runId: string;
  sourceProjectId: string;
  provider: string;
  models: string[];
  repetitions: number;
  promptSetVersionId: string;
  questionCount: number;
  /** Valid, non-holdout answers — the only denominator. */
  answerCount: number;
  capturedAt: string | null;
  subject: SnapshotEntity;
  competitors: SnapshotEntity[];
  questions: SnapshotQuestion[];
  versions: {
    scoringVersion: string;
    parserVersions: string[];
    classifierModels: string[];
    resolverPolicy: string;
  };
}

export type MeasurementGrade = "high" | "medium" | "low" | "not_comparable";

export interface MeasurementComparability {
  grade: MeasurementGrade;
  reasons: string[];
}

const GRADE_ORDER: Record<MeasurementGrade, number> = {
  high: 0,
  medium: 1,
  low: 2,
  not_comparable: 3,
};

/** Before/after is only claimed over the same instrument: same frozen
 * question set, same provider class, same subject, same resolver policy.
 * Everything else degrades the grade with a stated reason. */
export function assessMeasurementComparability(
  baseline: MeasurementSnapshot,
  next: MeasurementSnapshot
): MeasurementComparability {
  let grade: MeasurementGrade = "high";
  const reasons: string[] = [];
  const flag = (g: MeasurementGrade, reason: string) => {
    if (GRADE_ORDER[g] > GRADE_ORDER[grade]) grade = g;
    reasons.push(reason);
  };
  if (baseline.promptSetVersionId !== next.promptSetVersionId) {
    flag("not_comparable", "question set version differs from the baseline");
  }
  if (baseline.questionCount !== next.questionCount) {
    flag("not_comparable", `question count ${baseline.questionCount} → ${next.questionCount}`);
  }
  if (baseline.provider !== next.provider) {
    flag("not_comparable", `provider ${baseline.provider} → ${next.provider}`);
  }
  if (baseline.subject.companyId !== next.subject.companyId) {
    flag("not_comparable", "subject company differs");
  }
  if (baseline.versions.resolverPolicy !== next.versions.resolverPolicy) {
    flag("not_comparable", "entity-resolution policy changed — disclose before comparing");
  }
  if (baseline.versions.scoringVersion !== next.versions.scoringVersion) {
    flag("not_comparable", "scoring version changed");
  }
  const sameModels =
    baseline.models.length === next.models.length &&
    baseline.models.every((m) => next.models.includes(m));
  if (!sameModels) {
    flag("medium", `model changed (${baseline.models.join(", ")} → ${next.models.join(", ")})`);
  }
  const repRatio =
    Math.max(baseline.repetitions, next.repetitions) /
    Math.max(1, Math.min(baseline.repetitions, next.repetitions));
  if (repRatio > MEASUREMENT_REPETITION_RATIO_LIMIT) {
    flag("low", `repetitions ${baseline.repetitions} → ${next.repetitions}`);
  }
  if (baseline.answerCount > 0) {
    const ratio = Math.min(baseline.answerCount, next.answerCount) / Math.max(baseline.answerCount, next.answerCount);
    if (ratio < MEASUREMENT_ANSWER_RATIO_FLOOR) {
      flag("low", `valid answers ${baseline.answerCount} → ${next.answerCount} (partial run?)`);
    }
  } else {
    flag("not_comparable", "baseline has no valid answers");
  }
  if (next.answerCount === 0) flag("not_comparable", "remeasurement has no valid answers");
  const baselineAliases = new Set(baseline.subject.aliases);
  const aliasDrift = next.subject.aliases.filter((a) => !baselineAliases.has(a));
  if (aliasDrift.length > 0) {
    flag("medium", `subject aliases added since baseline: ${aliasDrift.join(", ")}`);
  }
  return { grade, reasons };
}

export interface EntityDelta {
  companyId: string;
  name: string;
  baseline: number;
  next: number;
  delta: number;
  distinctBaseline: number;
  distinctNext: number;
}

export interface CategoryDelta {
  category: string;
  baseline: number;
  next: number;
  delta: number;
}

export interface MeasurementComparison {
  baselineAnswerCount: number;
  nextAnswerCount: number;
  subject: EntityDelta;
  competitors: EntityDelta[];
  gainedQuestions: string[];
  lostQuestions: string[];
  categories: CategoryDelta[];
  /** Observed movement, phrased without causality. */
  statement: string;
}

function entityDelta(
  b: SnapshotEntity,
  n: SnapshotEntity | undefined
): EntityDelta {
  return {
    companyId: b.companyId,
    name: b.name,
    baseline: b.recommendedCount,
    next: n?.recommendedCount ?? 0,
    delta: (n?.recommendedCount ?? 0) - b.recommendedCount,
    distinctBaseline: b.distinctQuestions,
    distinctNext: n?.distinctQuestions ?? 0,
  };
}

export function compareMeasurements(
  baseline: MeasurementSnapshot,
  next: MeasurementSnapshot
): MeasurementComparison {
  const nextByPrompt = new Map(next.questions.map((q) => [q.promptId, q]));
  const gained: string[] = [];
  const lost: string[] = [];
  const categories = new Map<string, CategoryDelta>();
  for (const q of baseline.questions) {
    const after = nextByPrompt.get(q.promptId);
    const before = q.subjectRecommended > 0;
    const now = (after?.subjectRecommended ?? 0) > 0;
    if (!before && now) gained.push(q.text);
    if (before && !now) lost.push(q.text);
    const key = q.category ?? "uncategorized";
    const row = categories.get(key) ?? { category: key, baseline: 0, next: 0, delta: 0 };
    row.baseline += q.subjectRecommended;
    row.next += after?.subjectRecommended ?? 0;
    row.delta = row.next - row.baseline;
    categories.set(key, row);
  }
  const nextCompetitors = new Map(next.competitors.map((c) => [c.companyId, c]));
  const subject = entityDelta(baseline.subject, next.subject);
  const statement =
    `After the changes, ${baseline.subject.name} was recommended in ${next.subject.recommendedCount} of ` +
    `${next.answerCount} valid ${next.provider} answers, versus ${baseline.subject.recommendedCount} of ` +
    `${baseline.answerCount} at baseline (same ${baseline.questionCount} questions). ` +
    `This is an observed movement, not an attribution.`;
  return {
    baselineAnswerCount: baseline.answerCount,
    nextAnswerCount: next.answerCount,
    subject,
    competitors: baseline.competitors.map((c) => entityDelta(c, nextCompetitors.get(c.companyId))),
    gainedQuestions: gained,
    lostQuestions: lost,
    categories: [...categories.values()],
    statement,
  };
}

// --------------------------------------------------------------- renewal

export interface RenewalInput {
  endsOn: string;
  renewalReviewOn: string;
  stored: RenewalStatus;
  stage: EngagementStage;
}

/** Date-derived renewal state; explicit decisions (offered/renewed/declined)
 * are never overwritten by the calendar. */
export function deriveRenewalStatus(i: RenewalInput, today: string): RenewalStatus {
  if (i.stored === "offered" || i.stored === "renewed" || i.stored === "declined") return i.stored;
  if (i.stage === "renewed") return "renewed";
  if (i.stage === "completed" || i.stage === "churned") return i.stored === "not_due" || i.stored === "due" ? "lapsed" : i.stored;
  if (today >= i.endsOn) return "lapsed";
  if (today >= i.renewalReviewOn) return "due";
  return "not_due";
}

/** An active engagement moves into renewal review by the calendar. */
export function deriveStage(stage: EngagementStage, renewalReviewOn: string, today: string): EngagementStage {
  if (stage === "active" && today >= renewalReviewOn) return "renewal_review";
  return stage;
}

// --------------------------------------------------------- weekly update

export interface WeeklyUpdateInput {
  clientName: string;
  weekEnding: string;
  done: string[];
  inProgress: string[];
  needFromYou: string[];
  measurement: string | null;
  next: string[];
}

/** Plain, deterministic weekly update. Empty sections say so — no vanity
 * activity is invented to fill space. */
export function composeWeeklyUpdate(i: WeeklyUpdateInput): string {
  const list = (items: string[], empty: string) =>
    items.length === 0 ? `- ${empty}` : items.map((x) => `- ${x}`).join("\n");
  const quiet =
    i.done.length === 0 && i.needFromYou.length === 0 && i.measurement === null;
  const opener = quiet
    ? `Nothing material changed this week — no completed changes and no new measurement. That is a normal week while work is in progress; here is where things stand.`
    : `Here is where the work stands this week.`;
  return [
    `Weekly update — ${i.clientName} — week ending ${i.weekEnding}`,
    "",
    opener,
    "",
    "DONE — what changed this week",
    list(i.done, "No changes were completed this week."),
    "",
    "IN PROGRESS — what we are working on",
    list(i.inProgress, "Nothing in progress. The next items start once the blockers below clear."),
    "",
    "NEED FROM YOU",
    list(i.needFromYou, "Nothing is waiting on you."),
    "",
    "MEASUREMENT",
    i.measurement ?? "- No new measurement this week. The baseline stands; the next remeasurement is scheduled.",
    "",
    "NEXT",
    list(i.next, "Continue the current work items."),
  ].join("\n");
}

// ------------------------------------------------------- health signals

export interface HealthInput {
  stage: EngagementStage;
  onboardingDone: boolean;
  openApprovals: number;
  blockedOnClient: number;
  blockedOnUs: number;
  tasksInProgress: number;
  tasksDone: number;
  nextMeasurementOn: string | null;
  overdueInvoices: number;
  lastClientUpdateOn: string | null;
  renewalStatus: RenewalStatus;
  today: string;
}

export type SignalState = "ok" | "attention" | "waiting_client" | "waiting_us";

export interface HealthSignal {
  key: string;
  label: string;
  state: SignalState;
  detail: string;
}

export function healthSignals(i: HealthInput): HealthSignal[] {
  const signals: HealthSignal[] = [];
  signals.push({
    key: "onboarding",
    label: "Onboarding",
    state: i.onboardingDone ? "ok" : "attention",
    detail: i.onboardingDone ? "complete" : "incomplete",
  });
  signals.push({
    key: "client_waiting",
    label: "Waiting on client",
    state: i.openApprovals + i.blockedOnClient > 0 ? "waiting_client" : "ok",
    detail: `${i.openApprovals} approval(s), ${i.blockedOnClient} item(s) need client input`,
  });
  signals.push({
    key: "us_waiting",
    label: "Waiting on us",
    state: i.blockedOnUs > 0 ? "waiting_us" : "ok",
    detail: `${i.blockedOnUs} item(s) blocked internally or on third parties`,
  });
  signals.push({
    key: "progress",
    label: "Work progressing",
    state: i.tasksInProgress + i.tasksDone > 0 ? "ok" : "attention",
    detail: `${i.tasksInProgress} in progress, ${i.tasksDone} done`,
  });
  signals.push({
    key: "measurement",
    label: "Remeasurement scheduled",
    state: i.nextMeasurementOn ? (i.nextMeasurementOn < i.today ? "attention" : "ok") : "attention",
    detail: i.nextMeasurementOn
      ? i.nextMeasurementOn < i.today
        ? `overdue since ${i.nextMeasurementOn}`
        : `next on ${i.nextMeasurementOn}`
      : "none scheduled",
  });
  signals.push({
    key: "invoices",
    label: "Invoices current",
    state: i.overdueInvoices > 0 ? "attention" : "ok",
    detail: i.overdueInvoices > 0 ? `${i.overdueInvoices} overdue` : "current",
  });
  const stale =
    i.lastClientUpdateOn === null ||
    daysBetween(i.lastClientUpdateOn, i.today) > CLIENT_UPDATE_CADENCE_DAYS;
  signals.push({
    key: "communication",
    label: "Last client update",
    state: stale && i.stage !== "signed" ? "attention" : "ok",
    detail: i.lastClientUpdateOn ? `sent ${i.lastClientUpdateOn}` : "never",
  });
  signals.push({
    key: "renewal",
    label: "Renewal",
    state: i.renewalStatus === "due" || i.renewalStatus === "lapsed" ? "attention" : "ok",
    detail: i.renewalStatus.replace(/_/g, " "),
  });
  return signals;
}

/** The single next action for the operator, in priority order. */
export function nextAction(i: {
  stage: EngagementStage;
  commercial: GateVerdict;
  checklist: ChecklistItem[];
  openApprovals: number;
  blockedOnClient: number;
  measurementDue: boolean;
  renewalStatus: RenewalStatus;
}): string {
  if (i.stage === "completed" || i.stage === "churned") return "Engagement closed. Keep the record historical.";
  if (i.stage === "renewed") return "Renewed — continue on the new engagement row.";
  if (i.stage === "signed") {
    if (!i.commercial.ready) return `Clear the commercial gate: ${i.commercial.reasons.join(" ")}`;
    return "Commercial gate clear — start onboarding.";
  }
  if (i.stage === "onboarding") {
    const open = i.checklist.filter((c) => !c.done);
    if (open.length > 0) return `Finish onboarding: ${open.map((c) => c.label.toLowerCase()).join("; ")}.`;
    return "Onboarding complete — mark the engagement active.";
  }
  if (i.renewalStatus === "due" || i.stage === "renewal_review") {
    return "Prepare the renewal review: baseline vs latest measurement, work delivered, what remains.";
  }
  if (i.measurementDue) return "A scheduled remeasurement is due — start the run on the baseline question set.";
  if (i.openApprovals > 0) return `${i.openApprovals} change(s) await client approval — send the approval request.`;
  if (i.blockedOnClient > 0) return `${i.blockedOnClient} item(s) need client input — ask in the weekly update.`;
  return "Work the current plan; send the weekly update on cadence.";
}
