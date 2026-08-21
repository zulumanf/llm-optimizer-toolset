/**
 * Behavioral intent, recommended action, and funnel math for the prospecting
 * cockpit (spec 098). Pure functions over measured facts — no I/O, no ML.
 *
 * Three things this module keeps apart, on purpose:
 *   quality  — how commercially attractive the prospect is (existing
 *              qualification score; never recomputed here);
 *   intent   — what their AUDIT PAGE received after we put it in front of
 *              them (sessions, engaged time, depth, interactions, replies);
 *   stage    — where they are commercially (the recorded pipeline stage).
 *
 * Vocabulary discipline: every derived sentence says what the AUDIT received
 * ("4 external sessions"), never who did it. A second browser identity is a
 * "possible additional visitor", not "forwarded internally".
 */
import type { ProspectStage } from "@/lib/prospects/constants";

// ---------------------------------------------------------------------------
// Inputs — one record per prospect, assembled by dashboard.ts from the ledgers.

export interface AuditViewFact {
  viewedAt: Date;
  /** Browser session id from the beacon; null when no JS ran (bounce/no-JS). */
  sessionId: string | null;
  /** Browser visitor id (localStorage); null when unknown. */
  visitorId: string | null;
  /** Branded-link key the visit arrived through; null for bare-token URLs. */
  linkKey: string | null;
  engagedSeconds: number;
  maxScrollPercent: number;
  sectionsViewed: string[];
  evidenceExpanded: boolean;
  ctaClicked: boolean;
}

export interface ProspectBehaviorFacts {
  prospectId: string;
  businessName: string;
  launchId: string;
  launchName: string;
  /** Effective qualification score (override else computed), 0–100. */
  qualityScore: number | null;
  stage: ProspectStage;
  /** Every stage the prospect ever entered (history). */
  visitedStages: ProspectStage[];
  /** Transmitted sends from the ledger, ascending. `allowed` rows are
   * written only after dispatch succeeded (gmail/mock) or a human recorded
   * a manual send — never approved/scheduled/attempted. */
  sentAts: Date[];
  opens: number;
  /** Human-like external views only (dashboard.ts humanViews filter). */
  views: AuditViewFact[];
  hasEmail: boolean;
  auditPublished: boolean;
}

// ---------------------------------------------------------------------------
// Configuration — the only place thresholds and weights live.

export const ENGAGEMENT_RULES = {
  /** Engaged-time thresholds (seconds). */
  engagedSecondsMeaningful: 30,
  engagedSecondsDeep: 60,
  /** Scroll depth that counts as "read it". */
  deepScrollPercent: 75,
  /** An interaction (evidence, competitor section) only counts as
   * meaningful with at least this much dwell (spec 099 rule 5). */
  interactionMinEngagedSeconds: 10,
  /** Section keys emitted by the audit page beacon. */
  competitorSection: "competitors",
  authoritySection: "authority",
  /** Sessions at/above this are "repeat activity". */
  repeatSessions: 2,
  manySessions: 3,
} as const;

export const INTENT_WEIGHTS = {
  qualifyingView: 2,
  engagedMeaningful: 1, // ≥30s
  engagedDeep: 2, // ≥60s — replaces (not adds to) engagedMeaningful
  deepScroll: 2,
  competitorSection: 1,
  evidenceExpanded: 1,
  ctaClicked: 3,
  // Spec 099 rule 3: depth outranks repetition. Sessions without dwell are
  // weak evidence (bots, refreshes, a shared link) and can never reach
  // High intent on their own (2 + 1 + 1 = 4 < 6).
  repeatSession: 1,
  manySessions: 1, // additional, at 3+
  possibleSecondVisitor: 1,
  reply: 5,
  meeting: 10,
} as const;

export const INTENT_LABELS = [
  "Cold",
  "Aware",
  "Interested",
  "High intent",
  "Engaged",
  "Opportunity",
  /** External activity on an audit with no recorded send (spec 099 rule 1):
   * real, ranked for a human to resolve the ledger, never an intent claim. */
  "Unresolved",
] as const;
export type IntentLabel = (typeof INTENT_LABELS)[number];

/** Score floors for each label (checked top-down). Opportunity is not a
 * score band — it is any reply or meeting. */
const LABEL_FLOORS: { label: IntentLabel; min: number }[] = [
  { label: "Engaged", min: 10 },
  { label: "High intent", min: 6 },
  { label: "Interested", min: 3 },
  { label: "Aware", min: 1 },
];

/** Labels that assert strong intent — gated on a verified strong signal
 * (meaningful engagement or CTA), never on session count (spec 099 rule 2). */
const STRONG_INTENT_LABELS: readonly IntentLabel[] = ["High intent", "Engaged"];
const STRONG_SIGNAL_CAP: IntentLabel = "Interested";

export const FOLLOW_UP_RULES = {
  /** Business days after the last touch before a silent prospect is due. */
  silentCadenceBusinessDays: 3,
  /** Business days to wait after audit activity before a personalized
   * follow-up. Behavior raises priority and personalization, not frequency
   * — a next-morning email after a Thursday read feels triggered. */
  engagedCadenceBusinessDays: 2,
  /** Stop recommending follow-ups after this many touches without a reply:
   * initial + 3 follow-ups + close-loop. */
  maxTouches: 5,
} as const;

/** Below this many qualifying viewers, latency aggregates (median time to
 * first view) are shown with n or hidden — a median of one is not a median. */
export const LATENCY_MIN_SAMPLE = 5;

/** Follow-up cadence is counted in operator business days (spec 099 rule 6). */
export const OPERATOR_TIMEZONE = "America/New_York";
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: OPERATOR_TIMEZONE });
const SATURDAY = "Sat";
const SUNDAY = "Sun";

const isBusinessDay = (d: Date): boolean => {
  const day = WEEKDAY_FORMAT.format(d);
  return day !== SATURDAY && day !== SUNDAY;
};

const OFFSET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: OPERATOR_TIMEZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Midnight of the current calendar day in OPERATOR_TIMEZONE, as an
 * instant. A UTC server's local midnight is 8 PM ET — "today" must mean the
 * operator's day (spec 099). */
export function startOfOperatorDay(now: Date): Date {
  const part = (type: string): number =>
    Number(OFFSET_FORMAT.formatToParts(now).find((p) => p.type === type)?.value ?? "0");
  // Wall-clock time in the operator zone, read back as if it were UTC…
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  // …so the zone offset at this instant is the difference to the real instant.
  const offsetMs = wall - Math.floor(now.getTime() / 1000) * 1000;
  const wallMidnight = Date.UTC(part("year"), part("month") - 1, part("day"));
  return new Date(wallMidnight - offsetMs);
}

/** Whole business days (Mon–Fri in OPERATOR_TIMEZONE) elapsed from `from`
 * to `to`: counts each 24h step whose end falls on a business day. */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0;
  let count = 0;
  for (let t = from.getTime() + DAY_MS; t <= to.getTime(); t += DAY_MS) {
    if (isBusinessDay(new Date(t))) count += 1;
  }
  return count;
}

/** Quality score at/above this reads as "high authority" in the cockpit. */
export const HIGH_QUALITY_SCORE = 70;

/** Below this many contacted prospects, or this young, conversion
 * diagnostics say "not enough data" instead of guessing. */
export const DIAGNOSTIC_MIN_CONTACTED = 10;
/** Below this many contacted, the cohort renders as a compact arrow strip
 * instead of the full bar funnel — five prospects do not need bars. */
export const FULL_FUNNEL_MIN_CONTACTED = 25;
export const DIAGNOSTIC_MIN_COHORT_AGE_DAYS = 2;

const DAY_MS = 86_400_000;
/** Beacon-less views closer together than this are one visit. */
export const NO_BEACON_SESSION_GAP_MS = 30 * 60_000;

// Sales facts from the stage ladder. audit_sent / audit_viewed are NOT
// replies — the old dashboard counted them as such.
const REPLY_STAGES: readonly ProspectStage[] = [
  "replied",
  "discovery_scheduled",
  "discovery_completed",
  "proposal_sent",
  "negotiation",
  "verbal_yes",
  "contracted",
];
const MEETING_STAGES: readonly ProspectStage[] = [
  "discovery_scheduled",
  "discovery_completed",
  "proposal_sent",
  "negotiation",
  "verbal_yes",
  "contracted",
];
const PROPOSAL_STAGES: readonly ProspectStage[] = [
  "proposal_sent",
  "negotiation",
  "verbal_yes",
  "contracted",
];

// ---------------------------------------------------------------------------
// Derived per-prospect summary.

export type Attribution =
  | "none"
  | "pre_outreach_only"
  | "attributed_link"
  | "unattributed_external";

export interface EngagementSummary {
  /** Qualifying views after the first allowed send. */
  postOutreachViews: number;
  preOutreachViews: number;
  /** Distinct browser sessions across post-outreach views (a view without a
   * session id counts as its own session). */
  sessions: number;
  /** Distinct known browser identities; 0 when none reported one. */
  visitorIdentities: number;
  /** Views that carried no visitor identity (no JS / beacon blocked). */
  unknownIdentityViews: number;
  possibleAdditionalVisitor: boolean;
  repeat: boolean;
  engagedSeconds: number;
  maxScrollPercent: number;
  competitorSectionViewed: boolean;
  authoritySectionViewed: boolean;
  evidenceExpanded: boolean;
  ctaClicked: boolean;
  meaningfullyEngaged: boolean;
  firstPostOutreachViewAt: Date | null;
  lastActivityAt: Date | null;
  /** Seconds from first send to first qualifying post-outreach view. */
  secondsToFirstView: number | null;
  attribution: Attribution;
  /** No allowed send in the ledger, yet the audit received external
   * activity — it went out another way (manual, LinkedIn, forwarded). The
   * activity is real and ranked; it is NOT funnel evidence and NOT intent
   * (label "Unresolved") until the send is recorded (spec 099 rule 1). */
  outsideLedger: boolean;
}

export interface SalesFacts {
  contacted: boolean;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
  touches: number;
  replied: boolean;
  meeting: boolean;
  proposal: boolean;
  won: boolean;
  lost: boolean;
}

export interface ProspectIntent extends ProspectBehaviorFacts {
  engagement: EngagementSummary;
  sales: SalesFacts;
  intentScore: number;
  intentLabel: IntentLabel;
  highQuality: boolean;
  recommendedAction: string;
  /** 1 = act now … 9 = not contacted. See PRIORITY_TIERS. */
  priorityTier: number;
  followUpDue: boolean;
}

export const PRIORITY_TIERS = [
  "active conversation",
  "CTA clicked",
  "high authority + high intent",
  "deep audit engagement",
  "multiple sessions or unresolved attribution",
  "one audit visit",
  "follow-up due",
  "contacted, no activity",
  "not contacted",
] as const;

const visited = (f: ProspectBehaviorFacts, stages: readonly ProspectStage[]): boolean =>
  stages.includes(f.stage) || f.visitedStages.some((s) => stages.includes(s));

export function salesFacts(f: ProspectBehaviorFacts): SalesFacts {
  const sorted = [...f.sentAts].sort((a, b) => a.getTime() - b.getTime());
  return {
    contacted: sorted.length > 0,
    firstSentAt: sorted[0] ?? null,
    lastSentAt: sorted[sorted.length - 1] ?? null,
    touches: sorted.length,
    replied: visited(f, REPLY_STAGES),
    meeting: visited(f, MEETING_STAGES),
    proposal: visited(f, PROPOSAL_STAGES),
    won: visited(f, ["contracted"]),
    lost: f.stage === "closed_lost",
  };
}

export function summarizeEngagement(
  views: AuditViewFact[],
  firstSentAt: Date | null
): EngagementSummary {
  // Contacted: only views after the first send count. Never contacted per
  // the ledger: every human-like view counts as (unattributable) activity.
  const outsideLedger = firstSentAt === null && views.length > 0;
  const post = firstSentAt
    ? views.filter((v) => v.viewedAt.getTime() >= firstSentAt.getTime())
    : views;
  const pre = views.length - post.length;
  const sessionKeys = new Set<string>();
  const visitors = new Set<string>();
  let unknownIdentity = 0;
  // Engaged time: max per session (the beacon reports cumulative seconds),
  // summed across sessions.
  const engagedBySession = new Map<string, number>();
  let maxScroll = 0;
  const sections = new Set<string>();
  let evidence = false;
  let cta = false;
  let first: Date | null = null;
  let last: Date | null = null;
  // Beacon-less views (no JS ran: bounces, link scanners, no-script
  // fetches) must not each become a "session" — QA 2026-08-21 saw one IP
  // hit twice 74 s apart with two OS user agents and read as "repeat".
  // They collapse into one unverified session per NO_BEACON_SESSION_GAP_MS
  // gap; only beacon sessions are individually trusted.
  let lastNoBeaconAt = -Infinity;
  let noBeaconBucket = 0;
  const sorted = [...post].sort((a, b) => a.viewedAt.getTime() - b.viewedAt.getTime());
  sorted.forEach((v) => {
    let key: string;
    if (v.sessionId) key = v.sessionId;
    else {
      const t = v.viewedAt.getTime();
      if (t - lastNoBeaconAt > NO_BEACON_SESSION_GAP_MS) noBeaconBucket += 1;
      lastNoBeaconAt = t;
      key = `nobeacon:${noBeaconBucket}`;
    }
    sessionKeys.add(key);
    if (v.visitorId) visitors.add(v.visitorId);
    else unknownIdentity += 1;
    engagedBySession.set(key, Math.max(engagedBySession.get(key) ?? 0, v.engagedSeconds));
    maxScroll = Math.max(maxScroll, v.maxScrollPercent);
    v.sectionsViewed.forEach((s) => sections.add(s));
    evidence ||= v.evidenceExpanded;
    cta ||= v.ctaClicked;
    if (!first || v.viewedAt < first) first = v.viewedAt;
    if (!last || v.viewedAt > last) last = v.viewedAt;
  });
  const engagedSeconds = [...engagedBySession.values()].reduce((a, b) => a + b, 0);
  const competitor = sections.has(ENGAGEMENT_RULES.competitorSection);
  const authority = sections.has(ENGAGEMENT_RULES.authoritySection);
  // Spec 099 rule 5: an interaction without dwell is not meaningful.
  const interactionWithDwell =
    (evidence || competitor) && engagedSeconds >= ENGAGEMENT_RULES.interactionMinEngagedSeconds;
  const meaningful =
    engagedSeconds >= ENGAGEMENT_RULES.engagedSecondsMeaningful ||
    maxScroll >= ENGAGEMENT_RULES.deepScrollPercent ||
    cta ||
    interactionWithDwell;
  const attribution: Attribution =
    post.length === 0
      ? pre > 0
        ? "pre_outreach_only"
        : "none"
      : post.some((v) => v.linkKey !== null) && !outsideLedger
        ? "attributed_link"
        : "unattributed_external";
  const firstAt = first as Date | null;
  return {
    postOutreachViews: post.length,
    preOutreachViews: pre,
    sessions: sessionKeys.size,
    visitorIdentities: visitors.size,
    unknownIdentityViews: unknownIdentity,
    possibleAdditionalVisitor: visitors.size >= 2,
    repeat: sessionKeys.size >= ENGAGEMENT_RULES.repeatSessions,
    engagedSeconds,
    maxScrollPercent: maxScroll,
    competitorSectionViewed: competitor,
    authoritySectionViewed: authority,
    evidenceExpanded: evidence,
    ctaClicked: cta,
    meaningfullyEngaged: meaningful,
    firstPostOutreachViewAt: firstAt,
    lastActivityAt: last as Date | null,
    secondsToFirstView:
      firstAt && firstSentAt
        ? Math.round((firstAt.getTime() - firstSentAt.getTime()) / 1000)
        : null,
    attribution,
    outsideLedger,
  };
}

export function intentScore(e: EngagementSummary, s: SalesFacts): number {
  let score = 0;
  if (e.postOutreachViews > 0) score += INTENT_WEIGHTS.qualifyingView;
  if (e.engagedSeconds >= ENGAGEMENT_RULES.engagedSecondsDeep) score += INTENT_WEIGHTS.engagedDeep;
  else if (e.engagedSeconds >= ENGAGEMENT_RULES.engagedSecondsMeaningful)
    score += INTENT_WEIGHTS.engagedMeaningful;
  if (e.maxScrollPercent >= ENGAGEMENT_RULES.deepScrollPercent) score += INTENT_WEIGHTS.deepScroll;
  if (e.competitorSectionViewed) score += INTENT_WEIGHTS.competitorSection;
  if (e.evidenceExpanded) score += INTENT_WEIGHTS.evidenceExpanded;
  if (e.ctaClicked) score += INTENT_WEIGHTS.ctaClicked;
  if (e.repeat) score += INTENT_WEIGHTS.repeatSession;
  if (e.sessions >= ENGAGEMENT_RULES.manySessions) score += INTENT_WEIGHTS.manySessions;
  if (e.possibleAdditionalVisitor) score += INTENT_WEIGHTS.possibleSecondVisitor;
  if (s.replied) score += INTENT_WEIGHTS.reply;
  if (s.meeting) score += INTENT_WEIGHTS.meeting;
  return score;
}

export function intentLabel(score: number, s: SalesFacts, e: EngagementSummary): IntentLabel {
  if (s.replied || s.meeting) return "Opportunity";
  // Rule 1: no recorded send → the activity cannot be read as intent.
  if (e.outsideLedger) return "Unresolved";
  const band = LABEL_FLOORS.find((b) => score >= b.min)?.label ?? "Cold";
  // Rule 2: strong labels need a verified strong signal, not session count.
  const strongSignal = e.meaningfullyEngaged || e.ctaClicked;
  if (STRONG_INTENT_LABELS.includes(band) && !strongSignal) return STRONG_SIGNAL_CAP;
  return band;
}

/** Decision support only — never outreach copy, never a claim about who
 * viewed. Behavioral detail stays on the operator's side of the glass. */
export function recommendedAction(
  e: EngagementSummary,
  s: SalesFacts,
  facts: Pick<ProspectBehaviorFacts, "hasEmail" | "auditPublished">,
  followUpDue: boolean
): string {
  if (s.won) return "Client — hand off to onboarding.";
  if (s.lost) return "Closed lost — no action.";
  if (s.meeting) return "Prepare the meeting brief from the audit findings.";
  if (s.replied) return "Respond and advance the conversation.";
  if (!s.contacted) {
    if (e.outsideLedger) return "Audit is receiving external activity with no recorded send — record the send if it went out another way, then follow up.";
    if (!facts.auditPublished) return "Publish the audit before outreach.";
    if (!facts.hasEmail) return "Research a contact email to unlock outreach.";
    return "Ready to contact — draft and approve the first email.";
  }
  if (e.ctaClicked) return "Reach out promptly — the audit's call to action was used.";
  // Spec 099 rule 3: depth outranks repetition.
  if (e.meaningfullyEngaged && e.repeat) return "High-priority personalized follow-up — the audit was read, more than once.";
  if (e.meaningfullyEngaged) return "Prioritize a personalized follow-up.";
  if (e.repeat) return "Multiple short sessions — follow up with the strongest finding; depth not yet shown.";
  if (e.postOutreachViews > 0) return "Lead the follow-up with the strongest specific audit finding.";
  if (s.touches >= FOLLOW_UP_RULES.maxTouches) return "Max touches reached without activity — park or try another channel.";
  if (followUpDue) return "Follow up with a new reason to inspect the finding.";
  return "Wait — the send is recent; no activity yet.";
}

/** When a contacted, silent prospect becomes follow-up eligible under
 * FOLLOW_UP_RULES; null when no follow-up is ever due (replied, won, lost,
 * max touches). Pure companion to isFollowUpDue — "what will the OS do in
 * the next 24 hours" reads from this. */
export function followUpDueAt(e: EngagementSummary, s: SalesFacts): Date | null {
  if (!s.contacted || s.replied || s.lost || s.won || !s.lastSentAt) return null;
  if (s.touches >= FOLLOW_UP_RULES.maxTouches) return null;
  const lastActivity = e.lastActivityAt;
  if (lastActivity && lastActivity.getTime() > s.lastSentAt.getTime()) {
    return addBusinessDays(lastActivity, FOLLOW_UP_RULES.engagedCadenceBusinessDays);
  }
  return addBusinessDays(s.lastSentAt, FOLLOW_UP_RULES.silentCadenceBusinessDays);
}

/** Inverse of businessDaysBetween: the first instant at which `n` business
 * days have elapsed (weekends skipped, same operator-day convention). */
export function addBusinessDays(from: Date, n: number): Date {
  let t = from.getTime();
  while (businessDaysBetween(from, new Date(t)) < n) t += DAY_MS;
  return new Date(t);
}

export function isFollowUpDue(e: EngagementSummary, s: SalesFacts, now: Date): boolean {
  if (!s.contacted || s.replied || s.lost || s.won || !s.lastSentAt) return false;
  if (s.touches >= FOLLOW_UP_RULES.maxTouches) return false;
  const lastActivity = e.lastActivityAt;
  if (lastActivity && lastActivity.getTime() > s.lastSentAt.getTime()) {
    // They looked after our last email: wait the engaged cadence, then follow up.
    return businessDaysBetween(lastActivity, now) >= FOLLOW_UP_RULES.engagedCadenceBusinessDays;
  }
  return businessDaysBetween(s.lastSentAt, now) >= FOLLOW_UP_RULES.silentCadenceBusinessDays;
}

export function priorityTier(
  e: EngagementSummary,
  s: SalesFacts,
  highQuality: boolean,
  label: IntentLabel,
  followUpDue: boolean
): number {
  if (s.replied || s.meeting) return 1;
  if (e.ctaClicked) return 2;
  if (highQuality && STRONG_INTENT_LABELS.includes(label)) return 3;
  // Spec 099 rule 3: depth outranks repetition. Unresolved (no recorded
  // send) sits with multiple sessions so a human resolves the ledger.
  if (e.outsideLedger) return 5; // resolve the ledger before reading depth as intent
  if (e.meaningfullyEngaged) return 4;
  if (e.repeat) return 5;
  if (e.postOutreachViews > 0) return 6;
  if (followUpDue) return 7;
  if (s.contacted) return 8;
  return 9;
}

export function deriveIntent(f: ProspectBehaviorFacts, now: Date): ProspectIntent {
  const sales = salesFacts(f);
  const engagement = summarizeEngagement(f.views, sales.firstSentAt);
  const score = intentScore(engagement, sales);
  const label = intentLabel(score, sales, engagement);
  const highQuality = (f.qualityScore ?? 0) >= HIGH_QUALITY_SCORE;
  const followUpDue = isFollowUpDue(engagement, sales, now);
  return {
    ...f,
    engagement,
    sales,
    intentScore: score,
    intentLabel: label,
    highQuality,
    recommendedAction: recommendedAction(engagement, sales, f, followUpDue),
    priorityTier: priorityTier(engagement, sales, highQuality, label, followUpDue),
    followUpDue,
  };
}

/** Default cockpit order: tier, then intent, then quality, then recency. */
export function compareByPriority(a: ProspectIntent, b: ProspectIntent): number {
  return (
    a.priorityTier - b.priorityTier ||
    b.intentScore - a.intentScore ||
    (b.qualityScore ?? -1) - (a.qualityScore ?? -1) ||
    (b.engagement.lastActivityAt?.getTime() ?? 0) - (a.engagement.lastActivityAt?.getTime() ?? 0) ||
    a.businessName.localeCompare(b.businessName)
  );
}

// ---------------------------------------------------------------------------
// Cohort funnel + diagnostics.

export interface CohortFunnelStep {
  key: "contacted" | "viewed" | "engaged" | "replied" | "meeting" | "proposal" | "client";
  label: string;
  count: number;
  /** Denominator the rate is stated against, or null for the top step. */
  of: number | null;
  rate: number | null;
  basis: string;
}

export interface CohortSummary {
  contacted: number;
  viewed: number;
  engaged: number;
  replied: number;
  meeting: number;
  proposal: number;
  client: number;
  followUpDue: number;
  notContacted: number;
  /** Raw human-like view events on contacted prospects' audits (post-outreach). */
  auditViews: number;
  auditSessions: number;
  /** Distinct known browser identities across the cohort. */
  auditVisitorIdentities: number;
  /** Prospects whose audit had ANY human-like view, contacted or not. */
  prospectsWithAnyView: number;
  preOutreachViews: number;
  attributedLinkProspects: number;
  unattributedProspects: number;
  opens: number;
  openedProspects: number;
  cohortAgeDays: number | null;
  medianSecondsToFirstView: number | null;
  /** Sessions on never-contacted audits — real activity, excluded from
   * every campaign metric because no send is recorded (spec 099). */
  unresolvedSessions: number;
  funnel: CohortFunnelStep[];
  diagnosis: Diagnosis;
}

export interface Diagnosis {
  verdict: "not_enough_data" | "healthy" | "possible_bottleneck";
  bottleneck: "outreach" | "audit_experience" | "commercial_conversion" | "sales_conversion" | "offer" | null;
  reason: string;
  review: string[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

const rate = (n: number, of: number): number | null => (of > 0 ? n / of : null);

export function summarizeCohort(items: ProspectIntent[], now: Date): CohortSummary {
  const contacted = items.filter((p) => p.sales.contacted);
  const viewed = contacted.filter((p) => p.engagement.postOutreachViews > 0);
  const engaged = viewed.filter((p) => p.engagement.meaningfullyEngaged);
  const replied = contacted.filter((p) => p.sales.replied);
  const meeting = contacted.filter((p) => p.sales.meeting);
  const proposal = contacted.filter((p) => p.sales.proposal);
  const client = contacted.filter((p) => p.sales.won);
  const firstSends = contacted
    .map((p) => p.sales.firstSentAt?.getTime())
    .filter((t): t is number => t !== undefined);
  const cohortAgeDays =
    firstSends.length > 0 ? (now.getTime() - Math.min(...firstSends)) / DAY_MS : null;
  const visitorIds = new Set<string>();
  contacted.forEach((p) =>
    p.views.forEach((v) => {
      if (v.visitorId && p.sales.firstSentAt && v.viewedAt >= p.sales.firstSentAt) visitorIds.add(v.visitorId);
    })
  );
  const funnel: CohortFunnelStep[] = [
    { key: "contacted", label: "Contacted", count: contacted.length, of: null, rate: null, basis: "prospects with ≥1 allowed send in the ledger" },
    { key: "viewed", label: "Audit viewers", count: viewed.length, of: contacted.length, rate: rate(viewed.length, contacted.length), basis: "contacted prospects whose audit received ≥1 human-like external view after the first send" },
    { key: "engaged", label: "Meaningfully engaged", count: engaged.length, of: viewed.length, rate: rate(engaged.length, viewed.length), basis: `viewers with ≥${ENGAGEMENT_RULES.engagedSecondsMeaningful}s engaged, ≥${ENGAGEMENT_RULES.deepScrollPercent}% depth, CTA clicked, or evidence/competitor interaction with ≥${ENGAGEMENT_RULES.interactionMinEngagedSeconds}s engaged` },
    { key: "replied", label: "Replied", count: replied.length, of: contacted.length, rate: rate(replied.length, contacted.length), basis: "recorded stage ≥ replied (audit_sent / audit_viewed are not replies)" },
    { key: "meeting", label: "Meeting", count: meeting.length, of: contacted.length, rate: rate(meeting.length, contacted.length), basis: "recorded stage ≥ discovery_scheduled" },
    { key: "proposal", label: "Proposal", count: proposal.length, of: contacted.length, rate: rate(proposal.length, contacted.length), basis: "recorded stage ≥ proposal_sent" },
    { key: "client", label: "Client", count: client.length, of: contacted.length, rate: rate(client.length, contacted.length), basis: "recorded stage contracted" },
  ];
  const summary: Omit<CohortSummary, "diagnosis"> = {
    contacted: contacted.length,
    viewed: viewed.length,
    engaged: engaged.length,
    replied: replied.length,
    meeting: meeting.length,
    proposal: proposal.length,
    client: client.length,
    followUpDue: items.filter((p) => p.followUpDue).length,
    notContacted: items.filter((p) => !p.sales.contacted).length,
    auditViews: contacted.reduce((n, p) => n + p.engagement.postOutreachViews, 0),
    auditSessions: contacted.reduce((n, p) => n + p.engagement.sessions, 0),
    auditVisitorIdentities: visitorIds.size,
    prospectsWithAnyView: items.filter((p) => p.views.length > 0).length,
    preOutreachViews: items.reduce((n, p) => n + p.engagement.preOutreachViews, 0),
    attributedLinkProspects: viewed.filter((p) => p.engagement.attribution === "attributed_link").length,
    unattributedProspects: viewed.filter((p) => p.engagement.attribution === "unattributed_external").length,
    opens: contacted.reduce((n, p) => n + p.opens, 0),
    openedProspects: contacted.filter((p) => p.opens > 0).length,
    unresolvedSessions: items.filter((p) => p.engagement.outsideLedger).reduce((n, p) => n + p.engagement.sessions, 0),
    cohortAgeDays,
    medianSecondsToFirstView: median(
      viewed.map((p) => p.engagement.secondsToFirstView).filter((s): s is number => s !== null)
    ),
    funnel,
  };
  return { ...summary, diagnosis: diagnose(summary) };
}

/** Always "possible bottleneck", never causation. Silent on tiny or young
 * cohorts — day-one zeros are not a verdict. */
export function diagnose(c: Omit<CohortSummary, "diagnosis">): Diagnosis {
  if (c.contacted < DIAGNOSTIC_MIN_CONTACTED || c.cohortAgeDays === null || c.cohortAgeDays < DIAGNOSTIC_MIN_COHORT_AGE_DAYS) {
    return {
      verdict: "not_enough_data",
      bottleneck: null,
      reason:
        c.contacted < DIAGNOSTIC_MIN_CONTACTED
          ? `Fewer than ${DIAGNOSTIC_MIN_CONTACTED} contacted — early sample, directional only.`
          : `Batch is under ${DIAGNOSTIC_MIN_COHORT_AGE_DAYS} days old — too early to read conversion.`,
      review: [],
    };
  }
  const viewRate = rate(c.viewed, c.contacted) ?? 0;
  const engageRate = rate(c.engaged, c.viewed);
  const replyRate = rate(c.replied, c.contacted) ?? 0;
  const meetingRate = rate(c.meeting, c.replied);
  const closeRate = rate(c.client, c.meeting);
  if (viewRate < 0.15) {
    return { verdict: "possible_bottleneck", bottleneck: "outreach", reason: `${Math.round(viewRate * 100)}% of contacted prospects' audits received a view.`, review: ["targeting", "sender credibility", "subject line", "first sentence", "deliverability", "how the audit is positioned"] };
  }
  if (engageRate !== null && engageRate < 0.4) {
    return { verdict: "possible_bottleneck", bottleneck: "audit_experience", reason: `${Math.round(engageRate * 100)}% of viewers engaged meaningfully.`, review: ["hero", "page speed", "executive summary", "proof clarity", "mobile layout"] };
  }
  if (c.engaged >= 3 && replyRate < 0.05) {
    return { verdict: "possible_bottleneck", bottleneck: "commercial_conversion", reason: "Strong engagement, few replies.", review: ["urgency", "business value", "credibility", "call to action", "offer clarity", "next step"] };
  }
  if (c.replied >= 3 && meetingRate !== null && meetingRate < 0.3) {
    return { verdict: "possible_bottleneck", bottleneck: "sales_conversion", reason: "Replies are not turning into meetings.", review: ["reply handling", "meeting ask", "scheduling friction"] };
  }
  if (c.meeting >= 3 && closeRate !== null && closeRate < 0.2) {
    return { verdict: "possible_bottleneck", bottleneck: "offer", reason: "Meetings are not closing.", review: ["offer", "pricing", "sales process"] };
  }
  return { verdict: "healthy", bottleneck: null, reason: "No step is under-converting against the early benchmarks.", review: [] };
}
