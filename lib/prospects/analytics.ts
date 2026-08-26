/**
 * Canonical outreach analytics (spec 101). ONE set of definitions shared by
 * Operate and Analyze, computed over the same per-prospect derivations
 * (ProspectIntent) so the two views can never disagree on a denominator.
 * Pure functions; no I/O, no LLM.
 *
 * Definitions (all prospect-unique unless stated):
 *   sent         ≥1 transmitted send in the ledger (never drafts/scheduled)
 *   delivered    sent minus prospects whose recipient has a bounce suppression
 *   open signal  delivered prospects with ≥1 open event / delivered — DIRECTIONAL
 *   audit view   delivered prospects with ≥1 qualifying post-contact view / delivered
 *   engaged      meaningfully engaged / audit viewers
 *   repeat       ≥2 qualifying sessions / audit viewers ("multiple sessions")
 *   reply        recorded reply stage / delivered
 *   positive     NOT RECORDED yet (no reply classification exists) → null
 *   meeting      recorded meeting stage / delivered
 */
import { OPERATOR_TIMEZONE, type ProspectIntent, type SendFact } from "@/lib/prospects/intent";

export interface Rate {
  n: number;
  of: number;
  /** null when the denominator is empty OR the metric is not recorded. */
  rate: number | null;
}

export const rate = (n: number, of: number): Rate => ({ n, of, rate: of > 0 ? n / of : null });
const NOT_RECORDED: Rate = { n: 0, of: 0, rate: null };

/** Central minimum-sample policy. */
export const SAMPLE = { insufficient: 10, directional: 30 } as const;
export type SampleLabel = "Insufficient sample" | "Early directional signal" | "Comparable";
export function sampleLabel(n: number): SampleLabel {
  if (n < SAMPLE.insufficient) return "Insufficient sample";
  if (n < SAMPLE.directional) return "Early directional signal";
  return "Comparable";
}

export interface ProspectOutcome {
  p: ProspectIntent;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  viewed: boolean;
  engaged: boolean;
  repeat: boolean;
  replied: boolean;
  meeting: boolean;
  proposal: boolean;
  client: boolean;
}

export function outcome(p: ProspectIntent): ProspectOutcome {
  const sent = p.sales.contacted;
  const bounced = p.sends.some((s) => s.bounced);
  const delivered = sent && !bounced;
  const viewed = delivered && p.engagement.postOutreachViews > 0;
  return {
    p,
    sent,
    delivered,
    opened: delivered && p.opens > 0,
    viewed,
    engaged: viewed && p.engagement.meaningfullyEngaged,
    repeat: viewed && p.engagement.repeat,
    replied: delivered && p.sales.replied,
    meeting: delivered && p.sales.meeting,
    proposal: delivered && p.sales.proposal,
    client: delivered && p.sales.won,
  };
}

export interface OutreachMetrics {
  sent: number;
  delivered: number;
  delivery: Rate;
  openSignal: Rate;
  auditView: Rate;
  engagedView: Rate;
  repeatSession: Rate;
  reply: Rate;
  /** null rate until reply classification is recorded anywhere. */
  positiveReply: Rate;
  meeting: Rate;
  proposal: Rate;
  client: Rate;
  replyToMeeting: Rate;
  counts: { viewed: number; engaged: number; replied: number; meeting: number; proposal: number; client: number; opened: number };
}

export function outreachMetrics(items: ProspectIntent[]): OutreachMetrics {
  const o = items.map(outcome);
  const c = (k: keyof Omit<ProspectOutcome, "p">) => o.filter((x) => x[k]).length;
  const sent = c("sent"), delivered = c("delivered"), viewed = c("viewed"), engaged = c("engaged");
  const replied = c("replied"), meeting = c("meeting"), proposal = c("proposal"), client = c("client"), opened = c("opened");
  return {
    sent,
    delivered,
    delivery: rate(delivered, sent),
    openSignal: rate(opened, delivered),
    auditView: rate(viewed, delivered),
    engagedView: rate(engaged, viewed),
    repeatSession: rate(c("repeat"), viewed),
    reply: rate(replied, delivered),
    positiveReply: NOT_RECORDED,
    meeting: rate(meeting, delivered),
    proposal: rate(proposal, delivered),
    client: rate(client, delivered),
    replyToMeeting: rate(meeting, replied),
    counts: { viewed, engaged, replied, meeting, proposal, client, opened },
  };
}

export interface FunnelStage {
  key: string;
  label: string;
  count: number;
  /** conversion from the previous stage */
  step: number | null;
  /** conversion from delivered */
  overall: number | null;
}

export function funnelConversion(m: OutreachMetrics): FunnelStage[] {
  const raw: [string, string, number][] = [
    ["delivered", "Delivered", m.delivered],
    ["viewed", "Audit viewers", m.counts.viewed],
    ["engaged", "Meaningfully engaged", m.counts.engaged],
    ["replied", "Replied", m.counts.replied],
    ["meeting", "Meetings", m.counts.meeting],
    ["proposal", "Proposals", m.counts.proposal],
    ["client", "Clients", m.counts.client],
  ];
  return raw.map(([key, label, count], i) => {
    const prev = i === 0 ? null : raw[i - 1]![2];
    return {
      key,
      label,
      count,
      step: prev === null ? null : prev > 0 ? count / prev : null,
      overall: i === 0 ? null : m.delivered > 0 ? count / m.delivered : null,
    };
  });
}

/** One deterministic funnel diagnostic, silent below the sample floor. */
export function funnelDiagnostic(m: OutreachMetrics): { verdict: "insufficient" | "healthy" | "bottleneck"; title: string; detail: string } {
  if (m.delivered < SAMPLE.insufficient) {
    return { verdict: "insufficient", title: "Not enough data yet to diagnose the funnel.", detail: `${m.delivered} delivered — diagnostics begin at ${SAMPLE.insufficient}.` };
  }
  const open = m.openSignal.rate ?? 0, view = m.auditView.rate ?? 0, eng = m.engagedView.rate, rep = m.reply.rate ?? 0;
  if (view < 0.15 && open >= 0.3) return { verdict: "bottleneck", title: "Possible bottleneck: Email → Audit", detail: "Open signal is healthy relative to audit-view conversion — the body or the value proposition may not be earning the click. Open signal is directional." };
  if (view < 0.15) return { verdict: "bottleneck", title: "Possible bottleneck: Delivery / Subject → Open", detail: "Both open signal and audit views are low — sender, subject line, or deliverability deserve a look first." };
  if (eng !== null && eng < 0.4 && m.counts.viewed >= SAMPLE.insufficient) return { verdict: "bottleneck", title: "Possible bottleneck: Audit experience", detail: "Prospects open the audit but few engage meaningfully — first screen, speed, and proof clarity." };
  if (m.counts.engaged >= SAMPLE.insufficient && rep < 0.05) return { verdict: "bottleneck", title: "Possible bottleneck: Engagement → Reply", detail: "Prospects are consuming the audit but rarely entering conversation — call to action, offer clarity, next step." };
  if (m.counts.replied >= SAMPLE.insufficient && (m.replyToMeeting.rate ?? 0) < 0.3) return { verdict: "bottleneck", title: "Possible bottleneck: Reply → Meeting", detail: "Replies are not turning into meetings — reply handling and the meeting ask." };
  return { verdict: "healthy", title: "No step is under-converting against the early benchmarks.", detail: "Keep the sample growing before changing tactics." };
}

// ---------------------------------------------------------------------------
// Groupings. Every row carries the same OutreachMetrics shape.

export interface GroupRow {
  key: string;
  label: string;
  metrics: OutreachMetrics;
  sample: SampleLabel;
  /** Ordering aid: first send in the group. */
  firstSentAt: Date | null;
}

function groupBy(items: ProspectIntent[], keyOf: (p: ProspectIntent) => { key: string; label: string } | null): GroupRow[] {
  const groups = new Map<string, { label: string; items: ProspectIntent[] }>();
  for (const p of items) {
    const k = keyOf(p);
    if (!k) continue;
    const g = groups.get(k.key) ?? { label: k.label, items: [] };
    g.items.push(p);
    groups.set(k.key, g);
  }
  return [...groups.entries()].map(([key, g]) => {
    const metrics = outreachMetrics(g.items);
    const first = g.items.flatMap((p) => p.sentAts).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    return { key, label: g.label, metrics, sample: sampleLabel(metrics.delivered), firstSentAt: first };
  });
}

export const byCohort = (items: ProspectIntent[]): GroupRow[] =>
  groupBy(items, (p) => ({ key: p.launchId, label: `${p.launchName} · Batch 1` }))
    .sort((a, b) => (a.firstSentAt?.getTime() ?? Infinity) - (b.firstSentAt?.getTime() ?? Infinity));

export const QUALITY_TIERS: { key: string; label: string; min: number; max: number }[] = [
  { key: "tier1", label: "Tier 1 (≥70)", min: 70, max: 101 },
  { key: "tier2", label: "Tier 2 (40–69)", min: 40, max: 70 },
  { key: "tier3", label: "Tier 3 (<40)", min: -1, max: 40 },
];
export type SegmentDimension = "quality" | "market" | "type";
export const SEGMENT_DIMENSIONS: { key: SegmentDimension; label: string }[] = [
  { key: "quality", label: "Quality tier" },
  { key: "market", label: "Market" },
  { key: "type", label: "Prospect type" },
];

export function bySegment(items: ProspectIntent[], dim: SegmentDimension): GroupRow[] {
  if (dim === "market") return byCohort(items);
  if (dim === "type") return groupBy(items, (p) => ({ key: p.prospectType ?? "unknown", label: (p.prospectType ?? "unknown").replaceAll("_", " ") }));
  return groupBy(items, (p) => {
    if (p.qualityScore === null) return { key: "unscored", label: "Unscored" };
    const t = QUALITY_TIERS.find((t) => p.qualityScore! >= t.min && p.qualityScore! < t.max)!;
    return { key: t.key, label: t.label };
  }).sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Send-level groupings: touch, subject, strategy, timing. A send "earns" the
// outcomes that happened after it and before the next send to the same
// prospect (reply/meeting by timestamp; audit view by first post-send view).

export interface SendOutcome {
  send: SendFact;
  p: ProspectIntent;
  delivered: boolean;
  opened: boolean;
  viewedAfter: boolean;
  repliedAfter: boolean;
  meetingAfter: boolean;
}

export function sendOutcomes(items: ProspectIntent[]): SendOutcome[] {
  const out: SendOutcome[] = [];
  for (const p of items) {
    const o = outcome(p);
    p.sends.forEach((send, i) => {
      const next = p.sends[i + 1]?.sentAt.getTime() ?? Infinity;
      const start = send.sentAt.getTime();
      const inWindow = (d: Date | null) => d !== null && d.getTime() >= start && d.getTime() < next;
      const viewedAfter = o.delivered && p.views.some((v) => inWindow(v.viewedAt));
      out.push({
        send,
        p,
        delivered: o.delivered,
        opened: o.delivered && send.opens > 0,
        viewedAfter,
        repliedAfter: o.delivered && inWindow(p.repliedAt),
        meetingAfter: o.delivered && inWindow(p.meetingAt),
      });
    });
  }
  return out;
}

export interface SendGroupRow {
  key: string;
  label: string;
  sent: number;
  delivered: number;
  openSignal: Rate;
  auditView: Rate;
  reply: Rate;
  positiveReply: Rate;
  meeting: Rate;
  sample: SampleLabel;
}

function groupSends(sends: SendOutcome[], keyOf: (s: SendOutcome) => { key: string; label: string } | null): SendGroupRow[] {
  const groups = new Map<string, { label: string; items: SendOutcome[] }>();
  for (const s of sends) {
    const k = keyOf(s);
    if (!k) continue;
    const g = groups.get(k.key) ?? { label: k.label, items: [] };
    g.items.push(s);
    groups.set(k.key, g);
  }
  return [...groups.entries()].map(([key, g]) => {
    const delivered = g.items.filter((s) => s.delivered).length;
    return {
      key,
      label: g.label,
      sent: g.items.length,
      delivered,
      openSignal: rate(g.items.filter((s) => s.opened).length, delivered),
      auditView: rate(g.items.filter((s) => s.viewedAfter).length, delivered),
      reply: rate(g.items.filter((s) => s.repliedAfter).length, delivered),
      positiveReply: NOT_RECORDED,
      meeting: rate(g.items.filter((s) => s.meetingAfter).length, delivered),
      sample: sampleLabel(delivered),
    };
  });
}

export const byTouch = (items: ProspectIntent[]): SendGroupRow[] =>
  groupSends(sendOutcomes(items), (s) => ({ key: String(s.send.touch), label: `Touch ${s.send.touch}` })).sort((a, b) => Number(a.key) - Number(b.key));

/** Strategy = what the data records today: the draft channel (initial vs
 * follow-up). A finer strategy enum does not exist yet, so nothing finer is
 * reported. */
export const STRATEGY_LABELS: Record<string, string> = {
  email: "Initial audit email",
  followup_email: "Follow-up email",
  linkedin_message: "LinkedIn message",
  warm_intro: "Warm intro",
};
export const byStrategy = (items: ProspectIntent[]): SendGroupRow[] =>
  groupSends(sendOutcomes(items), (s) => {
    const ch = s.send.draftChannel ?? "unknown";
    return { key: ch, label: STRATEGY_LABELS[ch] ?? ch };
  }).sort((a, b) => (b.meeting.rate ?? b.reply.rate ?? 0) - (a.meeting.rate ?? a.reply.rate ?? 0));

/** Arm = message style, derived from the sent body at read time (spec 122):
 * a link in the body is Arm A, no link is Arm B (reply CTA). A send with no
 * draft body on file is reported as unclassified, never guessed. */
export const ARM_LABELS = {
  A: "Arm A · link CTA",
  B: "Arm B · reply CTA",
  unknown: "Unclassified (no draft body on file)",
} as const;
export const byArm = (items: ProspectIntent[]): SendGroupRow[] =>
  groupSends(sendOutcomes(items), (s) =>
    s.send.hasLink === null
      ? { key: "unknown", label: ARM_LABELS.unknown }
      : s.send.hasLink
        ? { key: "A", label: ARM_LABELS.A }
        : { key: "B", label: ARM_LABELS.B }
  ).sort((a, b) => a.key.localeCompare(b.key));

export const bySubject = (items: ProspectIntent[]): SendGroupRow[] =>
  groupSends(sendOutcomes(items), (s) => (s.send.subject ? { key: s.send.subject, label: s.send.subject } : null)).sort((a, b) => b.delivered - a.delivered);

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_BANDS: [number, number, string][] = [
  [5, 8, "5–8 AM"], [8, 10, "8–10 AM"], [10, 12, "10 AM–12 PM"], [12, 14, "12–2 PM"], [14, 17, "2–5 PM"], [17, 21, "5–9 PM"], [21, 29, "night"],
];
export function sendWindow(d: Date, timeZone: string = OPERATOR_TIMEZONE): { key: string; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hour12: false }).formatToParts(d);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "?";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const h = hour < 5 ? hour + 24 : hour;
  const band = HOUR_BANDS.find(([lo, hi]) => h >= lo && h < hi)?.[2] ?? "night";
  const dow = DOW.indexOf(wd.slice(0, 3));
  return { key: `${dow}-${band}`, label: `${wd} ${band}` };
}
export const byTiming = (items: ProspectIntent[]): SendGroupRow[] =>
  groupSends(sendOutcomes(items).filter((s) => s.send.touch === 1), (s) => sendWindow(s.send.sentAt)).sort((a, b) => a.key.localeCompare(b.key));

// ---------------------------------------------------------------------------
// Per-100 yield and evidence-based insights.

export function yieldPer100(m: OutreachMetrics): { label: string; value: number }[] | null {
  if (m.delivered < SAMPLE.insufficient) return null;
  const per = (n: number) => Math.round((n / m.delivered) * 1000) / 10;
  return [
    { label: "contacted", value: 100 },
    { label: "audit viewers", value: per(m.counts.viewed) },
    { label: "meaningfully engaged", value: per(m.counts.engaged) },
    { label: "replies", value: per(m.counts.replied) },
    { label: "meetings", value: per(m.counts.meeting) },
    { label: "proposals", value: per(m.counts.proposal) },
    { label: "clients", value: per(m.counts.client) },
  ];
}

export interface Insight {
  kind: "segment" | "sequence" | "message" | "cohort" | "timing";
  confidence: SampleLabel;
  title: string;
  evidence: string;
}

const pctText = (r: Rate) => (r.rate === null ? "—" : `${Math.round(r.rate * 100)}%`);

/** Deterministic, evidence-bearing observations. Emitted only when both
 * sides of a comparison clear the insufficient-sample floor; never causal,
 * never "winner". */
export function insights(items: ProspectIntent[]): Insight[] {
  const out: Insight[] = [];
  const pair = (kind: Insight["kind"], rows: { label: string; r: Rate; delivered: number }[], metric: string) => {
    const ok = rows.filter((x) => x.delivered >= SAMPLE.insufficient && x.r.rate !== null).sort((a, b) => b.r.rate! - a.r.rate!);
    if (ok.length < 2) return;
    const [top, second] = [ok[0]!, ok[1]!];
    if (top.r.rate! <= second.r.rate!) return;
    const conf = sampleLabel(Math.min(top.delivered, second.delivered));
    out.push({
      kind,
      confidence: conf === "Comparable" ? "Comparable" : "Early directional signal",
      title: `${top.label} shows a higher ${metric} than ${second.label}.`,
      evidence: `${top.r.n}/${top.r.of} vs ${second.r.n}/${second.r.of} (${pctText(top.r)} vs ${pctText(second.r)}).`,
    });
  };
  pair("segment", bySegment(items, "quality").map((g) => ({ label: g.label, r: g.metrics.auditView, delivered: g.metrics.delivered })), "audit-view rate");
  pair("cohort", byCohort(items).map((g) => ({ label: g.label, r: g.metrics.auditView, delivered: g.metrics.delivered })), "audit-view rate");
  pair("message", bySubject(items).map((g) => ({ label: `"${g.label}"`, r: g.auditView, delivered: g.delivered })), "audit-view rate");
  pair("timing", byTiming(items).map((g) => ({ label: g.label, r: g.auditView, delivered: g.delivered })), "audit-view rate");
  // Sequence: where do replies land by touch?
  const touches = byTouch(items);
  const replies = touches.reduce((n, t) => n + t.reply.n, 0);
  if (replies >= SAMPLE.insufficient) {
    const byThree = touches.filter((t) => Number(t.key) <= 3).reduce((n, t) => n + t.reply.n, 0);
    const share = Math.round((byThree / replies) * 100);
    out.push({ kind: "sequence", confidence: sampleLabel(replies), title: `${share}% of replies so far arrived by Touch 3.`, evidence: `${byThree}/${replies} replies on touches 1–3${share >= 90 ? " — review whether later touches remain worthwhile." : "."}` });
  }
  return out;
}
