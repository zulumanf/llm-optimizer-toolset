/**
 * Spec 101 — canonical outreach analytics: one denominator policy shared by
 * Operate and Analyze, send-level credit rules, sample floors, and honest
 * "not recorded" states. Pure fixtures; no database.
 */
import { describe, expect, it } from "vitest";
import {
  bySegment,
  bySubject,
  byTiming,
  byTouch,
  funnelConversion,
  funnelDiagnostic,
  insights,
  outreachMetrics,
  sampleLabel,
  sendWindow,
  yieldPer100,
} from "@/lib/prospects/analytics";
import { deriveIntent, type AuditViewFact, type ProspectBehaviorFacts, type SendFact } from "@/lib/prospects/intent";
import { summarizeCohort } from "@/lib/prospects/intent";

const NOW = new Date("2026-08-28T12:00:00Z");
const T1 = new Date("2026-08-18T13:00:00Z"); // Tue 9 AM ET
const T2 = new Date("2026-08-21T13:00:00Z");
const send = (sentAt: Date, touch: number, over: Partial<SendFact> = {}): SendFact => ({ sentAt, touch, subject: "S-A", draftChannel: touch === 1 ? "email" : "followup_email", opens: 0, bounced: false, ...over });
const view = (viewedAt: Date, over: Partial<AuditViewFact> = {}): AuditViewFact => ({ viewedAt, sessionId: `s${viewedAt.getTime()}`, visitorId: "v", linkKey: "k", engagedSeconds: 0, maxScrollPercent: 0, sectionsViewed: [], evidenceExpanded: false, ctaClicked: false, ...over });
let seq = 0;
const facts = (over: Partial<ProspectBehaviorFacts>): ProspectBehaviorFacts => ({
  prospectId: `p${++seq}`, businessName: `P${seq}`, launchId: "L1", launchName: "Jersey City", qualityScore: 75, stage: "contacted", visitedStages: ["contacted"],
  sentAts: [T1], sends: [send(T1, 1)], prospectType: "team", repliedAt: null, meetingAt: null, opens: 0, views: [], hasEmail: true, auditPublished: true, ...over,
});
const P = (over: Partial<ProspectBehaviorFacts> = {}) => deriveIntent(facts(over), NOW);

describe("canonical rates", () => {
  it("delivered excludes bounces; every rate names its denominator; positive reply is not recorded (null)", () => {
    const items = [
      P({ views: [view(new Date(T1.getTime() + 3_600_000), { engagedSeconds: 45 })], opens: 2 }),
      P({ views: [view(new Date(T1.getTime() + 3_600_000))] }),
      P({ sends: [send(T1, 1, { bounced: true })] }),
      P(),
      P({ sentAts: [], sends: [] }),
    ];
    const m = outreachMetrics(items);
    expect(m.sent).toBe(4);
    expect(m.delivered).toBe(3);
    expect(m.delivery).toEqual({ n: 3, of: 4, rate: 0.75 });
    expect(m.openSignal).toEqual({ n: 1, of: 3, rate: 1 / 3 });
    expect(m.auditView).toEqual({ n: 2, of: 3, rate: 2 / 3 });
    expect(m.engagedView).toEqual({ n: 1, of: 2, rate: 0.5 });
    expect(m.reply.rate).toBe(0);
    expect(m.positiveReply.rate).toBeNull();
    expect(m.meeting.of).toBe(3);
  });

  it("a raw page request alone never qualifies as engaged", () => {
    const m = outreachMetrics([P({ views: [view(new Date(T1.getTime() + 60_000))] })]);
    expect(m.counts.viewed).toBe(1);
    expect(m.counts.engaged).toBe(0);
  });

  it("Operate's cohort summary and Analyze's metrics agree on viewers/engaged/replied", () => {
    const items = [
      P({ views: [view(new Date(T1.getTime() + 3_600_000), { engagedSeconds: 40 })] }),
      P({ stage: "replied", visitedStages: ["contacted", "replied"], repliedAt: T2 }),
      P(),
      P({ sentAts: [], sends: [], views: [view(new Date(T1.getTime() - 86_400_000))] }),
    ];
    const a = outreachMetrics(items);
    const o = summarizeCohort(items, NOW);
    expect(a.delivered).toBe(o.contacted);
    expect(a.counts.viewed).toBe(o.viewed);
    expect(a.counts.engaged).toBe(o.engaged);
    expect(a.counts.replied).toBe(o.replied);
    expect(a.auditView.rate).toBe(o.funnel.find((f) => f.key === "viewed")!.rate);
  });

  it("empty denominators yield null rates, never 0", () => {
    const m = outreachMetrics([]);
    expect(m.auditView.rate).toBeNull();
    expect(funnelConversion(m)[1]!.step).toBeNull();
    expect(yieldPer100(m)).toBeNull();
  });
});

describe("sample policy and diagnostics", () => {
  it("labels samples at the central thresholds", () => {
    expect(sampleLabel(9)).toBe("Insufficient sample");
    expect(sampleLabel(10)).toBe("Early directional signal");
    expect(sampleLabel(30)).toBe("Comparable");
  });
  it("stays silent under 10 delivered, then names a possible bottleneck", () => {
    expect(funnelDiagnostic(outreachMetrics([P(), P()])).verdict).toBe("insufficient");
    const many = Array.from({ length: 20 }, (_, i) => P({ opens: i < 8 ? 1 : 0, views: i === 0 ? [view(new Date(T1.getTime() + 3_600_000))] : [] }));
    const d = funnelDiagnostic(outreachMetrics(many));
    expect(d.verdict).toBe("bottleneck");
    expect(d.title).toMatch(/Email → Audit/);
  });
});

describe("send-level credit", () => {
  it("credits views/replies to the last touch before them; later touches carry their own outcomes", () => {
    const items = [
      P({ sentAts: [T1, T2], sends: [send(T1, 1), send(T2, 2, { subject: "S-B" })], views: [view(new Date(T1.getTime() + 3_600_000))], stage: "replied", visitedStages: ["contacted", "replied"], repliedAt: new Date(T2.getTime() + 3_600_000) }),
      P(),
    ];
    const t = byTouch(items);
    expect(t.map((r) => r.key)).toEqual(["1", "2"]);
    expect(t[0]!.auditView).toEqual({ n: 1, of: 2, rate: 0.5 });
    expect(t[0]!.reply.n).toBe(0);
    expect(t[1]!.reply).toEqual({ n: 1, of: 1, rate: 1 });
    const subj = bySubject(items);
    expect(subj.find((s) => s.key === "S-B")!.reply.n).toBe(1);
    expect(subj.find((s) => s.key === "S-A")!.delivered).toBe(2);
  });
  it("timing buckets use the operator timezone (Tue 9 AM ET → Tue 8–10 AM) and only Touch 1", () => {
    expect(sendWindow(T1).label).toBe("Tue 8–10 AM");
    const rows = byTiming([P({ sentAts: [T1, T2], sends: [send(T1, 1), send(T2, 2)] })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent).toBe(1);
  });
});

describe("segments and insights", () => {
  it("quality tiers group by score and insights need ≥10 delivered per side", () => {
    const tier1 = Array.from({ length: 12 }, (_, i) => P({ qualityScore: 80, views: i < 6 ? [view(new Date(T1.getTime() + 3_600_000))] : [] }));
    const tier2 = Array.from({ length: 12 }, (_, i) => P({ qualityScore: 50, views: i < 2 ? [view(new Date(T1.getTime() + 3_600_000))] : [] }));
    const seg = bySegment([...tier1, ...tier2], "quality");
    expect(seg.map((g) => g.key)).toEqual(["tier1", "tier2"]);
    const found = insights([...tier1, ...tier2]);
    const s = found.find((i) => i.kind === "segment")!;
    expect(s.title).toMatch(/Tier 1 .* higher audit-view rate than Tier 2/);
    expect(s.evidence).toBe("6/12 vs 2/12 (50% vs 17%).");
    expect(s.confidence).toBe("Early directional signal");
    expect(insights(tier1.slice(0, 5).concat(tier2.slice(0, 5)))).toEqual([]);
  });
});
