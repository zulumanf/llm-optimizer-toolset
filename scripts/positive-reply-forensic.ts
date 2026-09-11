/**
 * Positive Reply Learning Log + repliers-vs-non-repliers comparison over the
 * derived view `outreach_reply_learning_log` (migration 102). Read-only.
 *
 *   npx tsx scripts/positive-reply-forensic.ts            # all delivered mismatch Touch 1s
 *   npx tsx scripts/positive-reply-forensic.ts --json     # machine-readable
 *
 * Prints N_POSITIVE_REPLIES explicitly and never claims significance: the
 * comparison is descriptive (medians / shares) and is meant to be re-run as
 * replies arrive. Mismatch strength comes from the canonical
 * `mismatchStrength` — the view deliberately does not restate it.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { mismatchStrength } from "@/lib/prospects/mismatch";

interface Row {
  prospectId: string; businessName: string; campaign: string | null; market: string | null;
  recipient: string; bounced: boolean; contactProvenance: string | null; teamOrAgent: string; templateVersion: string;
  touch1SendId: string; sentAt: Date; sentAtLocal: Date; sentIsodow: number; sentLocalHour: number;
  productionProspect: string; productionCompetitor: string; productionRatio: string;
  productionDifference: string; recommendationsProspect: number; recommendationsCompetitor: number;
  recommendationGap: number; denominator: number; competitor: string; distinctCompetitorQuestions: number | null;
  replyAt: Date | null; replyClassification: string | null; replyTouchNumber: number | null;
  hoursToReply: string | null; positiveReply: boolean; positiveReplyAt: Date | null;
  anyOpensBeforeReply: number; credibleOpensBeforeReply: number; credibleOpensTotal: number;
  firstCredibleOpenAt: Date | null; sequenceStatus: string | null; sequenceStopReason: string | null;
  reportRequested: boolean; reportPublishedAt: Date | null; reportSentAt: Date | null;
  reportViewedAt: Date | null; walkthroughRequestedAt: Date | null; callBookedAt: Date | null;
  offerMadeAt: Date | null; clientWonAt: Date | null; currentStage: string;
}

const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  const hi = s[m] ?? 0;
  const lo = s[m - 1] ?? hi;
  return s.length % 2 ? hi : (lo + hi) / 2;
};
const share = (rows: Row[], pred: (r: Row) => boolean): string =>
  rows.length === 0 ? "n/a" : `${rows.filter(pred).length}/${rows.length}`;
const top = (rows: Row[], key: (r: Row) => string, n = 3): string => {
  const c = new Map<string, number>();
  for (const r of rows) c.set(key(r), (c.get(key(r)) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ") || "n/a";
};
const fmtM = (v: string | number) => `$${(Number(v) / 1e6).toFixed(1)}M`;
const fmt = (v: number | null, d = 2) => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(d));

async function main() {
  const json = process.argv.includes("--json");
  const all = (await sql`select * from outreach_reply_learning_log order by sent_at`) as unknown as Row[];
  const rows = all.filter((r) => !r.bounced);
  const strength = (r: Row) => mismatchStrength({ productionRatio: Number(r.productionRatio), recommendationGap: r.recommendationGap });
  const positives = rows.filter((r) => r.positiveReply);
  const others = rows.filter((r) => !r.positiveReply);

  if (json) {
    console.log(JSON.stringify({ nSent: all.length, nDelivered: rows.length, nPositive: positives.length, rows: rows.map((r) => ({ ...r, mismatchStrength: strength(r) })) }, null, 2));
    await sql.end();
    return;
  }

  console.log(`POSITIVE REPLY LEARNING LOG — ${new Date().toISOString()}`);
  console.log(`N_SENT_TOUCH1 = ${all.length}   N_DELIVERED_TOUCH1 = ${rows.length} (bounce-suppressed excluded)   N_POSITIVE_REPLIES = ${positives.length}`);
  console.log("No significance claims are made at this sample size; medians and shares are descriptive only.\n");

  for (const r of positives) {
    const log: Record<string, unknown> = {
      prospect_id: r.prospectId, campaign: r.campaign, market: r.market, recipient: r.recipient,
      team_or_agent: r.teamOrAgent, touch_number: r.replyTouchNumber, template_version: r.templateVersion,
      sent_at: r.sentAt.toISOString(), reply_at: r.positiveReplyAt?.toISOString(), hours_to_reply: r.hoursToReply,
      credible_opens_before_reply: r.credibleOpensBeforeReply, any_opens_before_reply: r.anyOpensBeforeReply,
      production_prospect: fmtM(r.productionProspect), production_competitor: fmtM(r.productionCompetitor),
      production_ratio: Number(r.productionRatio).toFixed(3), recommendations_prospect: r.recommendationsProspect,
      recommendations_competitor: r.recommendationsCompetitor, recommendation_gap: r.recommendationGap,
      denominator: r.denominator, distinct_competitor_questions: r.distinctCompetitorQuestions,
      competitor: r.competitor, mismatch_strength: strength(r), contact_provenance: r.contactProvenance,
      sent_local: `${DAY[r.sentIsodow]} ${String(r.sentLocalHour).padStart(2, "0")}:00 local`,
      report_requested: r.reportRequested, report_published_at: r.reportPublishedAt?.toISOString() ?? null,
      report_sent_at: r.reportSentAt?.toISOString() ?? null, report_viewed: r.reportViewedAt !== null,
      walkthrough_requested: r.walkthroughRequestedAt !== null, call_booked: r.callBookedAt !== null,
      offer_made: r.offerMadeAt !== null, client_won: r.clientWonAt !== null, current_stage: r.currentStage,
    };
    console.log(`--- ${r.businessName}`);
    for (const [k, v] of Object.entries(log)) console.log(`  ${k}: ${v ?? "null"}`);
  }

  const num = (rows: Row[], f: (r: Row) => number | null) => median(rows.map(f).filter((x): x is number => x !== null && !Number.isNaN(x)));
  const dims: Array<[string, (g: Row[]) => string]> = [
    ["recommendation gap (median)", (g) => fmt(num(g, (r) => r.recommendationGap))],
    ["production ratio comp/prospect (median)", (g) => fmt(num(g, (r) => Number(r.productionRatio)), 3)],
    ["production difference (median)", (g) => { const m = num(g, (r) => Number(r.productionDifference)); return m === null ? "n/a" : fmtM(m); }],
    ["prospect production (median)", (g) => { const m = num(g, (r) => Number(r.productionProspect)); return m === null ? "n/a" : fmtM(m); }],
    ["prospect recommendations (median)", (g) => fmt(num(g, (r) => r.recommendationsProspect))],
    ["competitor recommendations (median)", (g) => fmt(num(g, (r) => r.recommendationsCompetitor))],
    ["distinct competitor questions (median)", (g) => fmt(num(g, (r) => r.distinctCompetitorQuestions))],
    ["mismatch strength STRONG share", (g) => share(g, (r) => strength(r) === "strong")],
    ["competitor concentration (top)", (g) => top(g, (r) => r.competitor)],
    ["market (top)", (g) => top(g, (r) => r.market ?? "?")],
    ["team share", (g) => share(g, (r) => r.teamOrAgent === "team")],
    ["credible opens before reply (median)", (g) => fmt(num(g, (r) => r.credibleOpensBeforeReply))],
    ["repeated credible opens (>=2 total) share", (g) => share(g, (r) => r.credibleOpensTotal >= 2)],
    ["send local hour (median)", (g) => fmt(num(g, (r) => r.sentLocalHour))],
    ["send day (top)", (g) => top(g, (r) => DAY[r.sentIsodow] ?? "?")],
    ["contact provenance (top)", (g) => top(g, (r) => r.contactProvenance ?? "unknown")],
    ["own-domain email share", (g) => share(g, (r) => !/@(gmail|yahoo|aol|hotmail|outlook)\./i.test(r.recipient))],
    ["template version (top)", (g) => top(g, (r) => r.templateVersion)],
    ["touch preceding reply (top)", (g) => top(g.filter((r) => r.replyAt), (r) => `T${r.replyTouchNumber}`)],
  ];
  console.log(`\nPOSITIVE REPLY (n=${positives.length})  vs  NO POSITIVE REPLY (n=${others.length})`);
  const w = Math.max(...dims.map(([d]) => d.length));
  for (const [label, f] of dims) console.log(`${label.padEnd(w)}  ${f(positives).padEnd(28)}  ${f(others)}`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
