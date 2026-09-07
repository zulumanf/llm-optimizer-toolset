/**
 * Acquisition control panel (Analyze tab). Pure derivations over ONE facts
 * bundle (lib/prospects/acquisition-facts.ts) so every number on the page —
 * hero, funnel, supply, follow-ups, evidence QA, ICP cuts, markets, the
 * bottleneck call, economics, the decision point and today's priorities —
 * comes from the same rows and the same rules. No I/O, no LLM, no score.
 *
 * Semantics (the truth the page is built around):
 * - The CURRENT EXPERIMENT (Era 2) is every allowed send whose draft chain
 *   froze competitive-mismatch evidence and is not a follow-up touch, a
 *   founder reply, a report delivery or an evidence correction. Era 1 is
 *   every other contacted prospect; the two are never pooled.
 * - Unique Touch 1 recipients are prospect-unique; delivered = not bounced.
 *   The positive-reply rate uses delivered recipients as its denominator.
 * - A reply's classification is the LATEST row recorded for that message
 *   (insert-only corrections win); auto-responders are not human replies.
 * - Replies are "after Touch N" (the last touch before them), never caused.
 * - Clients are signed engagements outside QA fixtures; fixtures never count.
 */
import {
  ACQUISITION_SAMPLE,
  BOUNCE_ALERT_RATE,
  DECISION_SAMPLE_TARGET,
  FOLLOWUP_CADENCE_BUSINESS_DAYS,
  FOLLOWUP_TEMPLATE_VERSIONS,
  GMAIL_DAILY_SEND_CAP,
  LOW_RUNWAY_DAYS,
  MATURE_AFTER_BUSINESS_DAYS,
  MISMATCH_TEMPLATE_VERSION,
  MISMATCH_THRESHOLDS,
  POSITIVE_RATE_BANDS,
  REPORT_VIEW_ALERT_RATE,
  RUNWAY_PLANNING_BUSINESS_DAYS,
  SEND_CAP_HEADROOM,
  type ProspectStage,
  type ReplyClassification,
} from "@/lib/prospects/constants";
import { activePricingPolicy, offerLabel, billingLabel } from "@/lib/pricing/policy";
import { addBusinessDays, isBusinessDay, wallClock } from "@/lib/prospects/business-days";
import { OPERATOR_TIMEZONE } from "@/lib/prospects/intent";
import { rate, SAMPLE, type Rate } from "@/lib/prospects/analytics";

// ----------------------------------------------------------------- facts

export interface T1Fact {
  sendId: string;
  prospectId: string;
  businessName: string;
  market: string;
  launchId: string;
  prospectType: string | null;
  sentAt: Date;
  bounced: boolean;
  runId: string | null;
  competitorCompanyId: string | null;
  competitorName: string | null;
  /** Counts as sent (frozen). */
  recsProspect: number;
  recsCompetitor: number;
  competitorProductionRatio: number | null;
  /** Latest evidence correction overlay, or null when the claim stands. */
  correctedProspect: number | null;
  correctedCompetitor: number | null;
  anyOpens: number;
  credibleOpens: number;
}

export interface ReplyFact {
  prospectId: string;
  receivedAt: Date;
  createdAt: Date;
  classification: ReplyClassification | string;
  pricingRequested: boolean;
}

export type SequenceStatus = "active" | "paused" | "replied" | "stopped" | "complete";
export interface SequenceFact {
  id: string;
  prospectId: string;
  status: SequenceStatus;
  nextTouch: 2 | 3 | null;
  nextDueAt: Date | null;
  pausedUntil: Date | null;
  pauseReason: string | null;
  stopReason: string | null;
}

export type TouchKind = "T2" | "T3" | "FOUNDER" | "CORRECTION";
export interface TouchSendFact {
  prospectId: string;
  kind: TouchKind;
  sentAt: Date;
  /** Founder reply whose body states the engagement offer. */
  offerPresented: boolean;
}

export interface ReportFact {
  prospectId: string;
  publishedAt: Date | null;
  firstViewedAt: Date | null;
}

export interface MarketSupplyFact {
  launchId: string;
  market: string;
  sourced: number;
  rtMatched: number;
  contactable: number;
  /** Ever rendered a Touch 1 with frozen mismatch evidence. */
  drafted: number;
  /** Approved, unsent, slotted — uncontacted prospects. */
  scheduled: number;
  /** Approved, unsent, unslotted, no send error — uncontacted prospects. */
  ready: number;
  /** Rendered but not approved — uncontacted prospects. */
  awaitingApproval: number;
  /** Approved, unslotted, carrying a send error. */
  parked: number;
}

export type QueuedKind = "T1" | "T2" | "T3" | "CORRECTION" | "FOUNDER" | "OTHER";
export interface QueuedDraftFact {
  /** Operator-local calendar day, YYYY-MM-DD. */
  day: string;
  kind: QueuedKind;
  n: number;
}

export interface Era1Fact {
  prospects: number;
  sends: number;
  repliedStage: number;
  positive: number;
  bounced: number;
  auditViewed: number;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
}

export interface OpportunityFact {
  prospectId: string;
  businessName: string;
  market: string;
  stage: ProspectStage | string;
  nextAction: string | null;
  nextActionOn: string | null;
  lastActivityKind: string | null;
  lastActivityAt: Date | null;
  lastSendAt: Date | null;
}

export interface CompetitorRankFact {
  runId: string;
  companyId: string;
  rank: number;
}

export interface RefusalFact {
  check: string;
  n: number;
  lastAt: Date;
}

export interface AcquisitionFacts {
  t1: T1Fact[];
  replies: ReplyFact[];
  sequences: SequenceFact[];
  touchSends: TouchSendFact[];
  reports: ReportFact[];
  supply: MarketSupplyFact[];
  queued: QueuedDraftFact[];
  era1: Era1Fact;
  opportunities: OpportunityFact[];
  competitorRanks: CompetitorRankFact[];
  clientsWon: number;
  /** Recorded benchmark API cost behind the frozen evidence; null when unrecorded. */
  benchmarkSpendUsd: number | null;
  refusals: RefusalFact[];
  capDeferrals: number;
  /** Connector active, or the send path proved itself recently (the
   * connector status can read expired while refresh still works). */
  gmailHealthy: boolean;
  capLimit: number;
}

// ----------------------------------------------------------------- panel

export type AcquisitionStatus = "PROMISING" | "HEALTHY" | "WATCH" | "WEAK" | "INSUFFICIENT DATA";
export type ReplyType = "HIGH_INTENT" | "POSITIVE_CURIOSITY";
export type SampleFlag = "INSUFFICIENT SAMPLE" | "SMALL SAMPLE" | "OK";
export type HypothesisStatus = "POSSIBLE" | "SUPPORTED" | "NO EVIDENCE" | "CONTRADICTED";
export type Bottleneck =
  | "QUALIFIED PROSPECT SUPPLY"
  | "CONTACT VERIFICATION"
  | "T1 REPLY RATE"
  | "FOLLOW-UP PIPELINE"
  | "REPLY TO CONVERSATION"
  | "REPORT CONSUMPTION"
  | "CONVERSATION TO OFFER"
  | "OFFER TO CLIENT"
  | "DELIVERABILITY"
  | "DATA INTEGRITY";
export type LossType = "BUG" | "HEALTHY_GATE" | "POLICY" | "SUPPLY";

export interface Hero {
  positiveReplies: Rate;
  uniqueT1: number;
  deliveredT1: number;
  sends: { t1: number; t2: number; t3: number; corrections: number; founder: number };
  inventory: { ready: number; scheduled: number; notReady: number };
  runwayDays: number | null;
  liveLeads: { positive: number; highIntent: number };
  clientsWon: number;
  status: AcquisitionStatus;
  statusReason: string;
}

export interface Opportunity {
  prospectId: string;
  businessName: string;
  market: string;
  replyType: ReplyType;
  lastAction: string;
  lastActionAt: Date | null;
  lastContactAt: Date | null;
  offerStatus: string;
  nextAction: string;
}

export interface FunnelRow {
  key: string;
  label: string;
  count: number;
  fromPrior: number | null;
  fromT1: number | null;
  /** false = NOT FULLY INSTRUMENTED; the count is a derived proxy. */
  instrumented: boolean;
  note?: string;
}

export interface EraRow {
  era: "Era 1" | "Era 2";
  label: string;
  uniqueProspects: number;
  positive: number;
  positiveRate: Rate;
  bounceRate: Rate;
  linkBehavior: string;
  note?: string;
}

export interface SupplyRow {
  key: string;
  label: string;
  count: number;
  fromPrior: number | null;
}

export interface Supply {
  rows: SupplyRow[];
  biggestDrop: { label: string; lossShare: number } | null;
  ready: number;
  scheduled: number;
  awaitingApproval: number;
  parked: number;
  notReady: number;
  followupLoadNext: number;
  dailyT1Capacity: number;
  runwayDays: number | null;
}

export interface FollowupPipeline {
  active: number;
  t2Due: number;
  t3Due: number;
  overdue: number;
  pausedEvidenceReview: number;
  oooPaused: number;
  stopped: number;
  replied: number;
  complete: number;
}

export interface TouchPerf {
  touch: "T1" | "T2" | "T3";
  sent: number;
  repliesAfter: number;
  positiveAfter: number;
  sample: SampleFlag;
}

export interface EvidenceQa {
  accurate: number;
  corrected: number;
  material: number;
  noLongerEligible: number;
  humanReview: number;
  pausedCorrectionSequences: number;
  activeNoLongerEligible: number;
  unresolved: number;
  correctionsSent: number;
  correctionReplies: number;
  alert: "ATTENTION REQUIRED" | "CLEAR";
}

export interface CutRow {
  label: string;
  n: number;
  positive: number;
  rate: Rate;
  sample: SampleFlag;
}

export interface MarketRow {
  market: string;
  contacted: number;
  positive: number;
  t1Ready: number;
  contactRate: Rate;
  medianGap: number | null;
  dominantCompetitor: string | null;
  status: "SMALL SAMPLE" | "PROMISING" | "WATCH" | "NO REPLY YET";
}

export interface BottleneckCall {
  name: Bottleneck;
  reason: string;
}

export interface Loss {
  type: LossType;
  label: string;
  impact: number;
  /** null = not derivable from data. */
  resolved: boolean | null;
}

export interface Economics {
  spendUsd: number | null;
  perT1Ready: number | null;
  perPositive: number | null;
  perHighIntent: number | null;
  clientsWon: number;
  cac: number | null;
  scenario: { label: string; cac: number } | null;
}

export interface DecisionPoint {
  delivered: number;
  clean: number;
  mature: number;
  cleanMature: number;
  target: number;
  frozen: { label: string; value: string }[];
}

export interface PlanDay {
  day: string;
  label: string;
  t1: number;
  t2: number;
  t2Projected: number;
  t3: number;
  corrections: number;
  total: number;
}

export interface AcquisitionPanel {
  hero: Hero;
  opportunities: Opportunity[];
  funnel: FunnelRow[];
  eras: EraRow[];
  supply: Supply;
  followups: FollowupPipeline;
  touchPerf: TouchPerf[];
  evidence: EvidenceQa;
  icp: {
    recommendations: CutRow[];
    competitorRank: CutRow[];
    entity: CutRow[];
    topProducer: null;
    hypothesis: { text: string; status: HypothesisStatus; reason: string };
  };
  markets: MarketRow[];
  bottleneck: { primary: BottleneckCall | null; secondary: BottleneckCall | null };
  losses: Loss[];
  economics: Economics;
  decision: DecisionPoint;
  priorities: { text: string; prospectId?: string }[];
  plan: PlanDay[];
  opens: { anyOpen: Rate; likelyHuman: Rate };
  report: { delivered: number; viewed: number; medianHoursToView: number | null; sample: SampleFlag };
}

export const ICP_HYPOTHESIS =
  "Successful challenger with some existing AI presence, but behind a dominant AI competitor";

const DAY_MS = 86_400_000;
const DOMINANT_COMPETITOR_MAX_RANK = 3;
const AUTO_REPLY: ReadonlySet<string> = new Set(["out_of_office"]);
const HUMAN_REVIEW_RE = /HUMAN_REVIEW_REQUIRED/;
const OOO_RE = /^out of office/i;
const CORRECTION_PAUSE_RE = /(Spec 130|MATERIAL_SENT_CLAIM_ERROR|NO_LONGER_ELIGIBLE|HUMAN_REVIEW_REQUIRED|evidence correction)/i;
const LATE_STAGES: ReadonlySet<string> = new Set(["proposal_sent", "negotiation", "verbal_yes", "contracted"]);
const EXIT_STAGES: ReadonlySet<string> = new Set(["closed_lost", "conflict_blocked", "waitlisted"]);

export const localDay = (d: Date, tz: string = OPERATOR_TIMEZONE): string => {
  const w = wallClock(d, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
};

/** Mismatch gate over effective counts (same rule as the queue and the pause review). */
export function stillEligible(recsProspect: number, recsCompetitor: number, ratio: number | null): boolean {
  return (
    recsCompetitor - recsProspect >= MISMATCH_THRESHOLDS.minRecommendationGap &&
    (ratio === null || ratio <= MISMATCH_THRESHOLDS.maxCompetitorProductionRatio)
  );
}

/** Prospect-unique Touch 1: the earliest mismatch send per prospect. */
export function uniqueTouch1(t1: T1Fact[]): T1Fact[] {
  const first = new Map<string, T1Fact>();
  for (const f of [...t1].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
    if (!first.has(f.prospectId)) first.set(f.prospectId, f);
  }
  return [...first.values()];
}

/** Latest classification per received message (insert-only corrections win). */
export function canonicalReplies(replies: ReplyFact[]): ReplyFact[] {
  const latest = new Map<string, ReplyFact>();
  for (const r of replies) {
    const key = `${r.prospectId}|${r.receivedAt.getTime()}`;
    const cur = latest.get(key);
    if (!cur || r.createdAt.getTime() > cur.createdAt.getTime()) latest.set(key, r);
  }
  return [...latest.values()].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}

const isHuman = (r: ReplyFact): boolean => !AUTO_REPLY.has(r.classification);
const isPositive = (r: ReplyFact): boolean => r.classification === "positive_interest";

/** Which touch a reply landed after: the last campaign touch sent before it. */
export function touchBefore(prospectId: string, at: Date, t1: T1Fact | undefined, touches: TouchSendFact[]): "T1" | "T2" | "T3" | "CORRECTION" | null {
  let best: { kind: "T1" | "T2" | "T3" | "CORRECTION"; t: number } | null = null;
  const consider = (kind: "T1" | "T2" | "T3" | "CORRECTION", d: Date) => {
    const t = d.getTime();
    if (t <= at.getTime() && (!best || t > best.t)) best = { kind, t };
  };
  if (t1) consider("T1", t1.sentAt);
  for (const s of touches) if (s.prospectId === prospectId && s.kind !== "FOUNDER") consider(s.kind, s.sentAt);
  return best ? (best as { kind: "T1" | "T2" | "T3" | "CORRECTION" }).kind : null;
}

export function acquisitionStatus(delivered: number, positive: number, clients: number): { status: AcquisitionStatus; reason: string } {
  if (delivered < ACQUISITION_SAMPLE.statusMin) {
    return { status: "INSUFFICIENT DATA", reason: `${delivered} delivered — a status needs ${ACQUISITION_SAMPLE.statusMin}.` };
  }
  const r = positive / delivered;
  const pct = `${Math.round(r * 1000) / 10}%`;
  if (clients > 0) return { status: "HEALTHY", reason: `${clients} client${clients === 1 ? "" : "s"} won; ${positive}/${delivered} positive (${pct}).` };
  if (r >= POSITIVE_RATE_BANDS.promising) {
    return positive >= ACQUISITION_SAMPLE.positiveForSupport
      ? { status: "HEALTHY", reason: `${positive}/${delivered} positive (${pct}) on a comparable sample; no client yet.` }
      : { status: "PROMISING", reason: `${positive}/${delivered} positive (${pct}); small sample, no client yet.` };
  }
  if (r >= POSITIVE_RATE_BANDS.watch) return { status: "WATCH", reason: `${positive}/${delivered} positive (${pct}) — below the ${POSITIVE_RATE_BANDS.promising * 100}% band.` };
  return { status: "WEAK", reason: `${positive}/${delivered} positive (${pct}) — under ${POSITIVE_RATE_BANDS.watch * 100}%.` };
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mode = (xs: (string | null)[]): string | null => {
  const c = new Map<string, number>();
  for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
};
const cut = (label: string, n: number, positive: number): CutRow => ({
  label,
  n,
  positive,
  rate: n >= ACQUISITION_SAMPLE.cutMin ? rate(positive, n) : { n: positive, of: n, rate: null },
  sample: n >= ACQUISITION_SAMPLE.cutMin ? "OK" : "SMALL SAMPLE",
});
const conv = (n: number, of: number): number | null => (of > 0 ? n / of : null);
const usd = (n: number): string => `$${n.toLocaleString("en-US")}`;

/** Business days between two instants (operator calendar), floored at 0. */
function businessDaysSince(from: Date, now: Date): number {
  let n = 0;
  let cursor = from;
  while (cursor.getTime() < now.getTime() && n < 400) {
    cursor = addBusinessDays(cursor, 1, OPERATOR_TIMEZONE);
    if (cursor.getTime() <= now.getTime()) n += 1;
  }
  return n;
}

/** The next N operator-local business days, today included when it is one. */
export function planningDays(now: Date, n: number = RUNWAY_PLANNING_BUSINESS_DAYS): string[] {
  const days: string[] = [];
  let cursor = now;
  if (!isBusinessDay(cursor, OPERATOR_TIMEZONE)) cursor = addBusinessDays(cursor, 1, OPERATOR_TIMEZONE);
  while (days.length < n) {
    days.push(localDay(cursor));
    cursor = addBusinessDays(cursor, 1, OPERATOR_TIMEZONE);
  }
  return days;
}

export function inventoryRunway(inventory: number, followupLoad: number, capLimit: number, planningDays: number = RUNWAY_PLANNING_BUSINESS_DAYS): { dailyT1Capacity: number; runwayDays: number } {
  const dailyLoad = Math.ceil(followupLoad / Math.max(1, planningDays));
  const dailyT1Capacity = Math.max(1, capLimit - SEND_CAP_HEADROOM - dailyLoad);
  return { dailyT1Capacity, runwayDays: inventory <= 0 ? 0 : Math.ceil(inventory / dailyT1Capacity) };
}

const dayLabel = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!, 12));
  return `${dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${m}/${d}`;
};

// ------------------------------------------------------------ derivation

export function deriveAcquisition(f: AcquisitionFacts, now: Date): AcquisitionPanel {
  const t1All = uniqueTouch1(f.t1);
  const t1ById = new Map(t1All.map((x) => [x.prospectId, x]));
  const delivered = t1All.filter((x) => !x.bounced);
  const deliveredIds = new Set(delivered.map((x) => x.prospectId));
  const replies = canonicalReplies(f.replies);
  const seqByProspect = new Map(f.sequences.map((s) => [s.prospectId, s]));

  // Replies attributed to the touch they followed (prospect-unique per touch).
  const humanByProspect = new Map<string, ReplyFact[]>();
  for (const r of replies) {
    if (!isHuman(r)) continue;
    humanByProspect.set(r.prospectId, [...(humanByProspect.get(r.prospectId) ?? []), r]);
  }
  const positiveIds = new Set(replies.filter((r) => isPositive(r) && deliveredIds.has(r.prospectId)).map((r) => r.prospectId));
  const anyHumanIds = new Set([...humanByProspect.keys()].filter((id) => deliveredIds.has(id)));
  const firstPositiveAt = new Map<string, Date>();
  for (const r of replies) if (isPositive(r) && !firstPositiveAt.has(r.prospectId)) firstPositiveAt.set(r.prospectId, r.receivedAt);
  const pricingIds = new Set(replies.filter((r) => isPositive(r) && r.pricingRequested).map((r) => r.prospectId));
  const founderSends = f.touchSends.filter((s) => s.kind === "FOUNDER");
  const reportDeliveredAt = new Map<string, Date>();
  for (const id of positiveIds) {
    const at = firstPositiveAt.get(id)!;
    const d = founderSends.filter((s) => s.prospectId === id && s.sentAt.getTime() >= at.getTime()).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())[0];
    if (d) reportDeliveredAt.set(id, d.sentAt);
  }
  const offerIds = new Set(founderSends.filter((s) => s.offerPresented && positiveIds.has(s.prospectId)).map((s) => s.prospectId));
  const conversationIds = new Set(
    [...reportDeliveredAt.entries()]
      .filter(([id, at]) => (humanByProspect.get(id) ?? []).some((r) => r.receivedAt.getTime() > at.getTime()))
      .map(([id]) => id)
  );
  const reportById = new Map(f.reports.map((r) => [r.prospectId, r]));
  const viewedIds = new Set([...positiveIds].filter((id) => reportById.get(id)?.firstViewedAt));
  const highIntentIds = new Set(
    [...positiveIds].filter((id) => {
      const stage = f.opportunities.find((o) => o.prospectId === id)?.stage ?? "";
      return pricingIds.has(id) || offerIds.has(id) || LATE_STAGES.has(stage);
    })
  );

  // ---------------------------------------------------------- sends
  const count = (k: TouchKind) => f.touchSends.filter((s) => s.kind === k).length;
  const sends = { t1: f.t1.length, t2: count("T2"), t3: count("T3"), corrections: count("CORRECTION"), founder: count("FOUNDER") };

  // ---------------------------------------------------------- supply
  const sum = (k: keyof Omit<MarketSupplyFact, "launchId" | "market">) => f.supply.reduce((n, m) => n + m[k], 0);
  const supplyTotals = { sourced: sum("sourced"), rtMatched: sum("rtMatched"), contactable: sum("contactable"), drafted: sum("drafted"), scheduled: sum("scheduled"), ready: sum("ready"), awaitingApproval: sum("awaitingApproval"), parked: sum("parked") };
  const supplyRows: SupplyRow[] = [
    { key: "sourced", label: "Prospects sourced", count: supplyTotals.sourced, fromPrior: null },
    { key: "rt", label: "RealTrends matched", count: supplyTotals.rtMatched, fromPrior: conv(supplyTotals.rtMatched, supplyTotals.sourced) },
    { key: "contact", label: "Contact verified", count: supplyTotals.contactable, fromPrior: conv(supplyTotals.contactable, supplyTotals.rtMatched) },
    { key: "eligible", label: "Mismatch eligible (T1 drafted)", count: supplyTotals.drafted, fromPrior: conv(supplyTotals.drafted, supplyTotals.contactable) },
    { key: "t1", label: "T1 sent", count: t1All.length, fromPrior: conv(t1All.length, supplyTotals.drafted) },
  ];
  // The biggest drop is a SUPPLY loss: sourcing → match → contact → eligible.
  // "T1 sent" lags eligibility by design (pacing), so it never competes.
  let biggestDrop: Supply["biggestDrop"] = null;
  for (const row of supplyRows) {
    if (row.fromPrior === null || row.key === "t1") continue;
    const loss = 1 - row.fromPrior;
    if (!biggestDrop || loss > biggestDrop.lossShare) biggestDrop = { label: row.label, lossShare: loss };
  }
  const horizonEnd = addBusinessDays(now, RUNWAY_PLANNING_BUSINESS_DAYS, OPERATOR_TIMEZONE);
  const followupLoadNext = f.sequences.filter((s) => s.status === "active" && s.nextDueAt !== null && s.nextDueAt.getTime() <= horizonEnd.getTime()).length;
  const inventory = supplyTotals.ready + supplyTotals.scheduled;
  const runway = inventoryRunway(inventory, followupLoadNext, f.capLimit);
  const notReady = Math.max(0, supplyTotals.contactable - supplyTotals.drafted);
  const supply: Supply = { rows: supplyRows, biggestDrop, ready: supplyTotals.ready, scheduled: supplyTotals.scheduled, awaitingApproval: supplyTotals.awaitingApproval, parked: supplyTotals.parked, notReady, followupLoadNext, dailyT1Capacity: runway.dailyT1Capacity, runwayDays: runway.runwayDays };

  // ---------------------------------------------------------- follow-ups
  const active = f.sequences.filter((s) => s.status === "active");
  const dueBy = now.getTime() + DAY_MS;
  const isOoo = (s: SequenceFact) => s.pausedUntil !== null || OOO_RE.test(s.pauseReason ?? "");
  const paused = f.sequences.filter((s) => s.status === "paused");
  const followups: FollowupPipeline = {
    active: active.length,
    t2Due: active.filter((s) => s.nextTouch === 2 && s.nextDueAt !== null && s.nextDueAt.getTime() <= dueBy).length,
    t3Due: active.filter((s) => s.nextTouch === 3 && s.nextDueAt !== null && s.nextDueAt.getTime() <= dueBy).length,
    // Overdue counts business time: a Friday slot deferred over a holiday
    // weekend is not late until the next business day has passed.
    overdue: active.filter((s) => s.nextDueAt !== null && addBusinessDays(s.nextDueAt, 1, OPERATOR_TIMEZONE).getTime() < now.getTime()).length,
    pausedEvidenceReview: paused.filter((s) => !isOoo(s)).length,
    oooPaused: paused.filter(isOoo).length,
    stopped: f.sequences.filter((s) => s.status === "stopped").length,
    replied: f.sequences.filter((s) => s.status === "replied").length,
    complete: f.sequences.filter((s) => s.status === "complete").length,
  };

  const perTouch = (touch: "T1" | "T2" | "T3"): TouchPerf => {
    const sent = touch === "T1" ? delivered.length : f.touchSends.filter((s) => s.kind === touch && deliveredIds.has(s.prospectId)).length;
    const after = (pred: (r: ReplyFact) => boolean) =>
      new Set(
        replies
          .filter((r) => isHuman(r) && pred(r) && deliveredIds.has(r.prospectId))
          .filter((r) => touchBefore(r.prospectId, r.receivedAt, t1ById.get(r.prospectId), f.touchSends) === touch)
          .map((r) => r.prospectId)
      ).size;
    return { touch, sent, repliesAfter: after(() => true), positiveAfter: after(isPositive), sample: sent < SAMPLE.insufficient ? "INSUFFICIENT SAMPLE" : "OK" };
  };
  const touchPerf = [perTouch("T1"), perTouch("T2"), perTouch("T3")];

  // ---------------------------------------------------------- evidence QA
  const effective = (x: T1Fact) => ({ p: x.correctedProspect ?? x.recsProspect, c: x.correctedCompetitor ?? x.recsCompetitor });
  const changed = (x: T1Fact) => x.correctedProspect !== null && (x.correctedProspect !== x.recsProspect || x.correctedCompetitor !== x.recsCompetitor);
  const noLonger = (x: T1Fact) => changed(x) && !stillEligible(effective(x).p, effective(x).c, x.competitorProductionRatio);
  const material = (x: T1Fact) => changed(x) && !noLonger(x);
  const correctionSentIds = new Set(f.touchSends.filter((s) => s.kind === "CORRECTION").map((s) => s.prospectId));
  const openState = (id: string) => {
    const s = seqByProspect.get(id);
    return !s || s.status === "active" || s.status === "paused";
  };
  const evidence: EvidenceQa = {
    accurate: t1All.filter((x) => !changed(x)).length,
    corrected: t1All.filter((x) => x.correctedProspect !== null).length,
    material: t1All.filter(material).length,
    noLongerEligible: t1All.filter(noLonger).length,
    humanReview: f.sequences.filter((s) => HUMAN_REVIEW_RE.test(s.pauseReason ?? "") || HUMAN_REVIEW_RE.test(s.stopReason ?? "")).length,
    pausedCorrectionSequences: paused.filter((s) => !isOoo(s) && CORRECTION_PAUSE_RE.test(s.pauseReason ?? "")).length,
    activeNoLongerEligible: t1All.filter((x) => noLonger(x) && seqByProspect.get(x.prospectId)?.status === "active").length,
    unresolved: t1All.filter((x) => changed(x) && !positiveIds.has(x.prospectId) && openState(x.prospectId) && !correctionSentIds.has(x.prospectId)).length,
    correctionsSent: sends.corrections,
    correctionReplies: new Set(replies.filter((r) => isHuman(r) && touchBefore(r.prospectId, r.receivedAt, t1ById.get(r.prospectId), f.touchSends) === "CORRECTION").map((r) => r.prospectId)).size,
    alert: "CLEAR",
  };
  evidence.alert = evidence.activeNoLongerEligible > 0 || evidence.unresolved > 0 ? "ATTENTION REQUIRED" : "CLEAR";

  // ---------------------------------------------------------- hero
  const status = acquisitionStatus(delivered.length, positiveIds.size, f.clientsWon);
  const hero: Hero = {
    positiveReplies: rate(positiveIds.size, delivered.length),
    uniqueT1: t1All.length,
    deliveredT1: delivered.length,
    sends,
    inventory: { ready: supply.ready, scheduled: supply.scheduled, notReady },
    runwayDays: supply.runwayDays,
    liveLeads: { positive: positiveIds.size, highIntent: highIntentIds.size },
    clientsWon: f.clientsWon,
    status: status.status,
    statusReason: status.reason,
  };

  // ---------------------------------------------------------- opportunities
  const opportunities: Opportunity[] = f.opportunities
    .filter((o) => positiveIds.has(o.prospectId) && !EXIT_STAGES.has(o.stage) && o.stage !== "contracted")
    .map((o) => {
      const id = o.prospectId;
      const reportAt = reportDeliveredAt.get(id) ?? null;
      const lastReply = (humanByProspect.get(id) ?? []).at(-1)?.receivedAt ?? null;
      const lastContactAt = [o.lastSendAt, lastReply].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const offerStatus = offerIds.has(id)
        ? `Offer presented · ${offerLabel(activePricingPolicy())}`
        : pricingIds.has(id)
          ? "Pricing requested — not yet answered"
          : "No pricing discussed";
      const nextAction =
        o.nextAction ??
        (offerIds.has(id)
          ? "Await the reply; follow up if silent"
          : conversationIds.has(id)
            ? "Answer the latest reply"
            : reportAt
              ? "Ask for the reaction to the report"
              : "Deliver the report");
      return {
        prospectId: id,
        businessName: o.businessName,
        market: o.market,
        replyType: highIntentIds.has(id) ? "HIGH_INTENT" : "POSITIVE_CURIOSITY",
        lastAction: o.lastActivityKind?.replaceAll("_", " ") ?? "—",
        lastActionAt: o.lastActivityAt,
        lastContactAt,
        offerStatus,
        nextAction,
      } satisfies Opportunity;
    })
    .sort((a, b) => (a.replyType === b.replyType ? (b.lastContactAt?.getTime() ?? 0) - (a.lastContactAt?.getTime() ?? 0) : a.replyType === "HIGH_INTENT" ? -1 : 1));

  // ---------------------------------------------------------- funnel
  const raw: [string, string, number, boolean, string?][] = [
    ["sourced", "Sourced", supplyTotals.sourced, true],
    ["rt", "RealTrends matched", supplyTotals.rtMatched, true],
    ["contact", "Contact verified", supplyTotals.contactable, true],
    ["eligible", "Mismatch eligible", supplyTotals.drafted, true, "Prospects whose T1 was rendered from frozen evidence; eligibility is only evaluated at draft time."],
    ["t1", "T1 sent", t1All.length, true],
    ["delivered", "T1 delivered", delivered.length, true],
    ["reply", "Any human reply", anyHumanIds.size, true, "Auto-responders excluded."],
    ["positive", "Positive human reply", positiveIds.size, true],
    ["requested", "Report requested", positiveIds.size, true, "In this experiment a positive reply is the report request."],
    ["reportDelivered", "Report delivered", reportDeliveredAt.size, true, "First founder reply after the positive reply."],
    ["reportViewed", "Report viewed", viewedIds.size, true, "External human-like views of the private report."],
    ["conversation", "Follow-up conversation", conversationIds.size, true, "A human reply after the report was delivered."],
    ["pricing", "Pricing requested", pricingIds.size, true, "Deterministic rule over the positive reply text."],
    ["offer", "Offer presented", offerIds.size, false, "Derived from the sent reply body; no explicit event exists yet."],
    ["client", "Client won", f.clientsWon, true, "Signed engagements; QA fixtures excluded."],
  ];
  const funnel: FunnelRow[] = raw.map(([key, label, n, instrumented, note], i) => ({
    key,
    label,
    count: n,
    fromPrior: i === 0 ? null : conv(n, raw[i - 1]![2]),
    fromT1: key === "sourced" || key === "rt" || key === "contact" || key === "eligible" || key === "t1" ? null : conv(n, delivered.length),
    instrumented,
    ...(note ? { note } : {}),
  }));

  // ---------------------------------------------------------- eras
  const eras: EraRow[] = [
    {
      era: "Era 1",
      label: "Audit-link / reply-first outreach",
      uniqueProspects: f.era1.prospects,
      positive: f.era1.positive,
      positiveRate: rate(f.era1.positive, f.era1.prospects - f.era1.bounced),
      bounceRate: rate(f.era1.bounced, f.era1.prospects),
      linkBehavior: `${f.era1.auditViewed} of ${f.era1.prospects} viewed the audit link`,
      note: "Reply capture was not instrumented in this era; recorded positives are a floor.",
    },
    {
      era: "Era 2",
      label: "Competitive-mismatch T1 + T2/T3",
      uniqueProspects: t1All.length,
      positive: positiveIds.size,
      positiveRate: rate(positiveIds.size, delivered.length),
      bounceRate: rate(t1All.length - delivered.length, t1All.length),
      linkBehavior: `No link in T1 · ${reportDeliveredAt.size} report${reportDeliveredAt.size === 1 ? "" : "s"} delivered on request`,
    },
  ];

  // ---------------------------------------------------------- ICP cuts
  const rankOf = (x: T1Fact): number | null => {
    if (!x.runId || !x.competitorCompanyId) return null;
    return f.competitorRanks.find((r) => r.runId === x.runId && r.companyId === x.competitorCompanyId)?.rank ?? null;
  };
  const group = (label: string, pred: (x: T1Fact) => boolean): CutRow => {
    const xs = delivered.filter(pred);
    return cut(label, xs.length, xs.filter((x) => positiveIds.has(x.prospectId)).length);
  };
  const recommendations = [group("0 recommendations", (x) => effective(x).p === 0), group("≥1 recommendation", (x) => effective(x).p >= 1)];
  const competitorRank = [
    group("Competitor ranked #1", (x) => rankOf(x) === 1),
    group("Competitor in top 3", (x) => (rankOf(x) ?? 99) > 1 && (rankOf(x) ?? 99) <= 3),
    group("Other", (x) => (rankOf(x) ?? 99) > 3),
  ];
  const entity = [group("Agent", (x) => x.prospectType === "individual_agent"), group("Team", (x) => x.prospectType === "team")];
  // "Dominant AI competitor" = the named competitor ranks in the top 3 of
  // its market run by recommended count; "some AI presence" = ≥1 effective
  // recommendation for the prospect.
  const profile = (x: T1Fact) => effective(x).p >= 1 && (rankOf(x) ?? 99) <= DOMINANT_COMPETITOR_MAX_RANK;
  const positivesT1 = delivered.filter((x) => positiveIds.has(x.prospectId));
  const matching = positivesT1.filter(profile).length;
  let hypothesis: { status: HypothesisStatus; reason: string };
  if (positivesT1.length === 0) hypothesis = { status: "NO EVIDENCE", reason: "No positive reply yet." };
  else if (positivesT1.length < ACQUISITION_SAMPLE.positiveForSupport) {
    hypothesis = matching === 0
      ? { status: "NO EVIDENCE", reason: `${positivesT1.length} positive, none matching the profile.` }
      : { status: "POSSIBLE", reason: `${matching} of ${positivesT1.length} positive replies match the profile; ${ACQUISITION_SAMPLE.positiveForSupport} needed before anything stronger.` };
  } else {
    const inP = delivered.filter(profile), outP = delivered.filter((x) => !profile(x));
    const rIn = conv(inP.filter((x) => positiveIds.has(x.prospectId)).length, inP.length) ?? 0;
    const rOut = conv(outP.filter((x) => positiveIds.has(x.prospectId)).length, outP.length) ?? 0;
    hypothesis = rIn >= 2 * rOut && rIn > 0
      ? { status: "SUPPORTED", reason: `Profile ${Math.round(rIn * 1000) / 10}% vs ${Math.round(rOut * 1000) / 10}% outside (n=${inP.length}/${outP.length}).` }
      : rIn < rOut
        ? { status: "CONTRADICTED", reason: `Profile ${Math.round(rIn * 1000) / 10}% vs ${Math.round(rOut * 1000) / 10}% outside (n=${inP.length}/${outP.length}).` }
        : { status: "POSSIBLE", reason: `Profile ${Math.round(rIn * 1000) / 10}% vs ${Math.round(rOut * 1000) / 10}% outside — not separated yet.` };
  }

  // ---------------------------------------------------------- markets
  const marketName = (s: string): string => s.split(" —")[0]!.split(" luxury")[0]!.trim();
  const byMarket = new Map<string, T1Fact[]>();
  for (const x of delivered) byMarket.set(marketName(x.market), [...(byMarket.get(marketName(x.market)) ?? []), x]);
  const supplyByMarket = new Map<string, MarketSupplyFact[]>();
  for (const m of f.supply) supplyByMarket.set(marketName(m.market), [...(supplyByMarket.get(marketName(m.market)) ?? []), m]);
  const marketNames = new Set([...byMarket.keys(), ...[...supplyByMarket.entries()].filter(([, ms]) => ms.some((m) => m.ready + m.scheduled > 0)).map(([k]) => k)]);
  const markets: MarketRow[] = [...marketNames]
    .map((name) => {
      const xs = byMarket.get(name) ?? [];
      const ms = supplyByMarket.get(name) ?? [];
      const positive = xs.filter((x) => positiveIds.has(x.prospectId)).length;
      const contacted = xs.length;
      const status: MarketRow["status"] = contacted < ACQUISITION_SAMPLE.cutMin ? "SMALL SAMPLE" : positive / contacted >= POSITIVE_RATE_BANDS.promising ? "PROMISING" : positive > 0 ? "WATCH" : "NO REPLY YET";
      return {
        market: name,
        contacted,
        positive,
        t1Ready: ms.reduce((n, m) => n + m.ready + m.scheduled, 0),
        contactRate: rate(ms.reduce((n, m) => n + m.contactable, 0), ms.reduce((n, m) => n + m.rtMatched, 0)),
        medianGap: median(xs.map((x) => effective(x).c - effective(x).p)),
        dominantCompetitor: mode(xs.map((x) => x.competitorName)),
        status,
      };
    })
    .sort((a, b) => b.positive - a.positive || b.contacted - a.contacted || a.market.localeCompare(b.market));

  // ---------------------------------------------------------- report + opens
  const viewHours = [...positiveIds].flatMap((id) => {
    const d = reportDeliveredAt.get(id), v = reportById.get(id)?.firstViewedAt;
    return d && v ? [(v.getTime() - d.getTime()) / 3_600_000] : [];
  });
  const report = {
    delivered: reportDeliveredAt.size,
    viewed: viewedIds.size,
    medianHoursToView: median(viewHours),
    sample: (reportDeliveredAt.size < ACQUISITION_SAMPLE.funnelMin ? "INSUFFICIENT SAMPLE" : "OK") as SampleFlag,
  };
  const opens = {
    anyOpen: rate(delivered.filter((x) => x.anyOpens > 0).length, delivered.length),
    likelyHuman: rate(delivered.filter((x) => x.credibleOpens > 0).length, delivered.length),
  };

  // ---------------------------------------------------------- bottleneck
  const calls: BottleneckCall[] = [];
  if (evidence.activeNoLongerEligible > 0 || (followups.pausedEvidenceReview > 0 && followups.pausedEvidenceReview >= followups.active)) {
    calls.push({ name: "DATA INTEGRITY", reason: `${evidence.activeNoLongerEligible} no-longer-eligible sequence${evidence.activeNoLongerEligible === 1 ? "" : "s"} still active; ${followups.pausedEvidenceReview} paused for evidence review vs ${followups.active} active.` });
  }
  const bounceShare = conv(t1All.length - delivered.length, t1All.length) ?? 0;
  if (!f.gmailHealthy || (t1All.length >= ACQUISITION_SAMPLE.cutMin && bounceShare >= BOUNCE_ALERT_RATE)) {
    calls.push({ name: "DELIVERABILITY", reason: !f.gmailHealthy ? "Gmail connection is not active." : `${Math.round(bounceShare * 1000) / 10}% of T1 recipients bounced.` });
  }
  if (supply.runwayDays !== null && supply.runwayDays < LOW_RUNWAY_DAYS) {
    const contactDrop = biggestDrop?.label === "Contact verified";
    calls.push({
      name: contactDrop ? "CONTACT VERIFICATION" : "QUALIFIED PROSPECT SUPPLY",
      reason: `${inventory} T1 ready+scheduled ≈ ${supply.runwayDays} sending day${supply.runwayDays === 1 ? "" : "s"}; biggest supply drop at ${biggestDrop?.label ?? "—"} (${Math.round((biggestDrop?.lossShare ?? 0) * 100)}% lost).`,
    });
  }
  if (followups.overdue > 0 || followups.pausedEvidenceReview > followups.active) {
    calls.push({ name: "FOLLOW-UP PIPELINE", reason: `${followups.overdue} follow-up${followups.overdue === 1 ? "" : "s"} overdue by more than a day; ${followups.pausedEvidenceReview} paused vs ${followups.active} active.` });
  }
  if (delivered.length >= ACQUISITION_SAMPLE.statusMin && (hero.positiveReplies.rate ?? 0) < POSITIVE_RATE_BANDS.watch) {
    calls.push({ name: "T1 REPLY RATE", reason: `${positiveIds.size}/${delivered.length} positive — under ${POSITIVE_RATE_BANDS.watch * 100}%.` });
  }
  if (positiveIds.size > 0 && conversationIds.size === 0) {
    calls.push({ name: "REPLY TO CONVERSATION", reason: `${positiveIds.size} positive repl${positiveIds.size === 1 ? "y" : "ies"}, ${reportDeliveredAt.size} report${reportDeliveredAt.size === 1 ? "" : "s"} delivered, no follow-up conversation yet (n=${positiveIds.size}; watch, not a verdict).` });
  } else if (positiveIds.size >= ACQUISITION_SAMPLE.funnelMin && conversationIds.size / positiveIds.size < 0.5) {
    calls.push({ name: "REPLY TO CONVERSATION", reason: `${conversationIds.size} of ${positiveIds.size} positive replies became a conversation.` });
  }
  if (report.delivered >= ACQUISITION_SAMPLE.funnelMin && report.viewed / report.delivered < REPORT_VIEW_ALERT_RATE) {
    calls.push({ name: "REPORT CONSUMPTION", reason: `${report.viewed} of ${report.delivered} delivered reports viewed.` });
  }
  if (conversationIds.size >= ACQUISITION_SAMPLE.funnelMin && offerIds.size === 0) {
    calls.push({ name: "CONVERSATION TO OFFER", reason: `${conversationIds.size} conversations, no offer presented.` });
  }
  if (offerIds.size >= 3 && f.clientsWon === 0) {
    calls.push({ name: "OFFER TO CLIENT", reason: `${offerIds.size} offers presented, no client.` });
  }
  const bottleneck = { primary: calls[0] ?? null, secondary: calls[1] ?? null };

  // ---------------------------------------------------------- losses
  const lossType = (check: string): LossType =>
    /brokerage/i.test(check) ? "BUG" : /draft_qa|greeting|signature|prepared_by|placeholder|entity|lint/i.test(check) ? "HEALTHY_GATE" : "POLICY";
  const lossRows: Loss[] = [
    { type: "BUG", label: "Entity-resolution corrections (lead-agent aliases)", impact: evidence.corrected, resolved: evidence.corrected === 0 ? null : evidence.unresolved === 0 },
    ...f.refusals.map((r): Loss => ({ type: lossType(r.check), label: `Send gate refused: ${r.check.replaceAll("_", " ")}`, impact: r.n, resolved: now.getTime() - r.lastAt.getTime() > DAY_MS })),
    { type: "POLICY", label: "Send-cap deferrals", impact: f.capDeferrals, resolved: null },
    { type: "POLICY", label: "Out-of-office pauses", impact: followups.oooPaused, resolved: null },
    { type: "SUPPLY", label: "RealTrends-matched prospects without a verified contact", impact: Math.max(0, supplyTotals.rtMatched - supplyTotals.contactable), resolved: false },
    { type: "SUPPLY", label: "Parked T1 drafts (send error)", impact: supplyTotals.parked, resolved: supplyTotals.parked === 0 },
  ];
  const losses = lossRows.filter((l) => l.impact > 0);

  // ---------------------------------------------------------- economics
  const spend = f.benchmarkSpendUsd;
  const per = (n: number): number | null => (spend === null || n === 0 ? null : Math.round((spend / n) * 100) / 100);
  const engagementValue = activePricingPolicy().totalFeeUsd;
  const economics: Economics = {
    spendUsd: spend,
    perT1Ready: per(t1All.length + inventory),
    perPositive: per(positiveIds.size),
    perHighIntent: per(highIntentIds.size),
    clientsWon: f.clientsWon,
    cac: f.clientsWon > 0 ? per(f.clientsWon) : null,
    scenario: f.clientsWon === 0 && spend !== null ? { label: `If one ${usd(engagementValue)} engagement closes`, cac: Math.round(spend * 100) / 100 } : null,
  };

  // ---------------------------------------------------------- decision point
  const matureIds = new Set(
    delivered
      .filter((x) => {
        const s = seqByProspect.get(x.prospectId)?.status;
        return s === "replied" || s === "complete" || positiveIds.has(x.prospectId) || businessDaysSince(x.sentAt, now) >= MATURE_AFTER_BUSINESS_DAYS;
      })
      .map((x) => x.prospectId)
  );
  const cleanIds = new Set(delivered.filter((x) => !changed(x)).map((x) => x.prospectId));
  const decision: DecisionPoint = {
    delivered: delivered.length,
    clean: cleanIds.size,
    mature: matureIds.size,
    cleanMature: [...cleanIds].filter((id) => matureIds.has(id)).length,
    target: DECISION_SAMPLE_TARGET,
    frozen: [
      { label: "T1 body", value: MISMATCH_TEMPLATE_VERSION },
      { label: "T2 / T3 copy", value: `${FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement.replace(/_no_engagement.*/, "")} v2 branches` },
      { label: "CTA", value: "reply-only; report on request" },
      { label: "Cadence", value: `T2 +${FOLLOWUP_CADENCE_BUSINESS_DAYS[2]} · T3 +${FOLLOWUP_CADENCE_BUSINESS_DAYS[3]} business days` },
      { label: "Pricing", value: `${offerLabel(activePricingPolicy())} · ${billingLabel(activePricingPolicy())} · ${activePricingPolicy().version}` },
      { label: "Thresholds", value: `gap ≥ ${MISMATCH_THRESHOLDS.minRecommendationGap} · ratio ≤ ${MISMATCH_THRESHOLDS.maxCompetitorProductionRatio} · benchmark ≤ ${MISMATCH_THRESHOLDS.maxBenchmarkAgeDays}d` },
      { label: "Daily cap", value: `${GMAIL_DAILY_SEND_CAP} / trailing 24h` },
    ],
  };

  // ---------------------------------------------------------- plan
  const days = planningDays(now);
  const firstDay = days[0]!;
  const bucket = (day: string): string => (day < firstDay ? firstDay : day);
  const plan: PlanDay[] = days.map((day) => ({ day, label: dayLabel(day), t1: 0, t2: 0, t2Projected: 0, t3: 0, corrections: 0, total: 0 }));
  const at = (day: string): PlanDay | undefined => plan.find((p) => p.day === bucket(day));
  for (const q of f.queued) {
    const p = at(q.day);
    if (!p) continue;
    if (q.kind === "T1") {
      p.t1 += q.n;
      const t2Day = localDay(addBusinessDays(new Date(`${q.day}T12:00:00Z`), FOLLOWUP_CADENCE_BUSINESS_DAYS[2], OPERATOR_TIMEZONE));
      const p2 = plan.find((x) => x.day === t2Day);
      if (p2) p2.t2Projected += q.n;
    } else if (q.kind === "CORRECTION") p.corrections += q.n;
  }
  for (const s of active) {
    if (!s.nextDueAt || !s.nextTouch) continue;
    const p = at(localDay(s.nextDueAt));
    if (!p) continue;
    if (s.nextTouch === 2) p.t2 += 1; else p.t3 += 1;
  }
  for (const p of plan) p.total = p.t1 + p.t2 + p.t2Projected + p.t3 + p.corrections;

  // ---------------------------------------------------------- priorities
  const priorities: { text: string; prospectId?: string }[] = [];
  for (const o of opportunities.filter((o) => o.replyType === "HIGH_INTENT")) priorities.push({ text: `${o.businessName}: high-intent lead — ${o.nextAction}`, prospectId: o.prospectId });
  for (const o of opportunities.filter((o) => o.replyType === "POSITIVE_CURIOSITY")) priorities.push({ text: `${o.businessName}: positive lead — ${o.nextAction}`, prospectId: o.prospectId });
  if (supply.runwayDays !== null && supply.runwayDays < LOW_RUNWAY_DAYS) priorities.push({ text: `T1 inventory low: ${inventory} ready or scheduled (~${supply.runwayDays} sending day${supply.runwayDays === 1 ? "" : "s"}) — source and verify contacts` });
  if (evidence.unresolved > 0) priorities.push({ text: `${evidence.unresolved} corrected claim${evidence.unresolved === 1 ? "" : "s"} need a founder decision (correct, resume, or stop)` });
  if (followups.t2Due + followups.t3Due > 0) priorities.push({ text: `${followups.t2Due + followups.t3Due} follow-up${followups.t2Due + followups.t3Due === 1 ? "" : "s"} due within 24h (T2 ${followups.t2Due} · T3 ${followups.t3Due})` });
  if (!f.gmailHealthy) priorities.push({ text: "Gmail connection is not active — outbound is blocked" });

  return {
    hero,
    opportunities,
    funnel,
    eras,
    supply,
    followups,
    touchPerf,
    evidence,
    icp: { recommendations, competitorRank, entity, topProducer: null, hypothesis: { text: ICP_HYPOTHESIS, ...hypothesis } },
    markets,
    bottleneck,
    losses,
    economics,
    decision,
    priorities: priorities.slice(0, 5),
    plan,
    opens,
    report,
  };
}
